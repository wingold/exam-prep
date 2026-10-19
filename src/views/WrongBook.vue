<script setup>
import { ref, computed, onMounted } from 'vue'
import db, { uid, now } from '../db'
import { isCorrect, isKeyQuestion } from '../importers'
import { enrollCard, rateCard, reconcileWrongBook, isMasteredCard, masteredHint, MASTERED_DAYS, MASTERED_REPS } from '../srs'
import { scheduleSync } from '../sync'
import Icon from '../components/Icon.vue'
import AiTutor from '../components/AiTutor.vue'

const items = ref([]) // [{wrongItem, question}]
const filter = ref('active') // active | cleared
const reasonFilter = ref('')
const REASONS = ['粗心', '不会', '审题', '没时间']

// 重做会话
const redo = ref(null) // { list, idx, answers, revealed }

async function reload() {
  // 先把错题的掌握状态与记忆卡排期对齐，再读列表
  await reconcileWrongBook()
  const wrongs = await db.wrongItems.where('status').equals(filter.value === 'active' ? 'active' : 'cleared').toArray()
  const out = []
  for (const w of wrongs) {
    const q = await db.questions.get(w.questionId)
    if (!q) continue
    const card = await db.cards.get(w.questionId)
    out.push({ w, q, card })
  }
  out.sort((a, b) => (b.w.updatedAt || 0) - (a.w.updatedAt || 0))
  items.value = out
}

onMounted(reload)

const shown = computed(() =>
  reasonFilter.value ? items.value.filter((i) => (i.w.wrongReasons || []).includes(reasonFilter.value)) : items.value
)

const reasonStats = computed(() => {
  const m = {}
  items.value.forEach((i) => (i.w.wrongReasons || []).forEach((r) => { m[r] = (m[r] || 0) + 1 }))
  return Object.entries(m).sort((a, b) => b[1] - a[1])
})

async function toggleReason(item, r) {
  const cur = item.w.wrongReasons || []
  const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]
  await db.wrongItems.update(item.w.id, { wrongReasons: next, updatedAt: now() })
  item.w.wrongReasons = next
}

async function markCleared(item) {
  // 手动标记掌握：保留用户判断，不再被排期回收
  await db.wrongItems.update(item.w.id, { status: 'cleared', clearedBy: 'user', updatedAt: now() })
  await reload()
}

async function reopen(item) {
  await db.wrongItems.update(item.w.id, { status: 'active', clearedBy: null, updatedAt: now() })
  await reload()
}

async function remove(item) {
  if (!confirm('从错题本移除这道题？（做题记录保留）')) return
  await db.wrongItems.delete(item.w.id)
  await reload()
}

/* ---- 错题重做 ---- */
function startRedo() {
  if (!shown.value.length) return
  redo.value = {
    list: shown.value.map((i) => ({ ...i })),
    idx: 0,
    answers: {},
    revealed: false,
  }
}

const rq = computed(() => (redo.value ? redo.value.list[redo.value.idx].q : null))
const rChosen = computed(() => (rq.value ? redo.value.answers[rq.value.id] || [] : []))

function toggleR(letter) {
  const q = rq.value
  const arr = redo.value.answers[q.id] ? [...redo.value.answers[q.id]] : []
  if (q.type === 'multi') {
    const i = arr.indexOf(letter)
    i >= 0 ? arr.splice(i, 1) : arr.push(letter)
  } else {
    arr.length = 0
    arr.push(letter)
  }
  redo.value.answers[q.id] = arr
}

const rRight = computed(() => rq.value ? isCorrect(rq.value, rChosen.value) : false)

const rTyped = ref('')

async function submitRedo() {
  const q = rq.value
  if (q.type === 'fill' || q.type === 'essay') redo.value.answers[q.id] = [rTyped.value]
  if (!(redo.value.answers[q.id] || []).length && q.type !== 'essay' && q.type !== 'fill') return
  redo.value.revealed = true
  const ok = rRight.value
  await db.attempts.put({ id: uid(), questionId: q.id, bankId: q.bankId, mode: 'review', chosen: [...(redo.value.answers[q.id] || [])], correct: ok, at: now() })
  const item = redo.value.list[redo.value.idx]
  if (ok) {
    // 排期统一交给记忆队列：答对只推进一个间隔，
    // 是否移出错题本由「间隔是否达到阈值」判定，不再用「连对 2 次」另立一套标准
    await rateCard(q.id, 'good')
    const card = await db.cards.get(q.id)
    const streak = (item.w.rightStreak || 0) + 1
    const status = isMasteredCard(card) ? 'cleared' : item.w.status
    if (status !== item.w.status) {
      await db.wrongItems.update(item.w.id, { rightStreak: streak, status, clearedBy: status === 'cleared' ? 'srs' : null, updatedAt: now() })
    } else {
      await db.wrongItems.update(item.w.id, { rightStreak: streak, updatedAt: now() })
    }
    item.w.rightStreak = streak
    item.w.status = status
    item.card = card
  } else {
    await db.wrongItems.update(item.w.id, { rightStreak: 0, wrongCount: (item.w.wrongCount || 1) + 1, updatedAt: now() })
    await enrollCard(q.id, { lapsed: true })
    item.w.rightStreak = 0
    item.w.status = 'active'
    item.card = await db.cards.get(q.id)
  }
  scheduleSync()
}

function nextRedo() {
  redo.value.revealed = false
  rTyped.value = ''
  if (redo.value.idx + 1 >= redo.value.list.length) {
    redo.value = null
    reload()
  } else {
    redo.value.idx++
  }
}

function quitRedo() {
  redo.value = null
  reload()
}
</script>

<template>
  <div>
    <!-- ===== 重做会话 ===== -->
    <template v-if="redo && rq">
      <div class="row between" style="margin-bottom: 14px">
        <span class="tiny">错题重做 {{ redo.idx + 1 }} / {{ redo.list.length }}</span>
        <button class="btn ghost sm" @click="quitRedo">退出</button>
      </div>

      <div class="card" style="margin-bottom: 14px">
        <div class="row between" style="margin-bottom: 8px">
          <span class="tiny">{{ rq.chapter || '' }}</span>
          <div class="row" style="gap: 6px">
            <span class="tag red" v-if="isKeyQuestion(rq)">重点</span>
            <span class="tag">{{ { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '简答' }[rq.type] }}</span>
          </div>
        </div>
        <div style="font-size: 16px; font-weight: 600; white-space: pre-wrap">{{ rq.stem }}</div>
      </div>

      <div v-if="['single', 'multi', 'judge'].includes(rq.type)" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px">
        <button
          v-for="(opt, i) in (rq.type === 'judge' && !rq.options.length ? ['对', '错'] : rq.options)"
          :key="i"
          class="card row"
          style="padding: 13px 16px; text-align: left; cursor: pointer; gap: 12px"
          :style="redo.revealed
            ? (rq.answer.includes(rq.type === 'judge' ? opt : 'ABCDEF'[i])
              ? { borderColor: 'var(--green)', background: 'var(--green-weak)' }
              : rChosen.includes(rq.type === 'judge' ? opt : 'ABCDEF'[i])
                ? { borderColor: 'var(--red)', background: 'var(--red-weak)' }
                : {})
            : rChosen.includes(rq.type === 'judge' ? opt : 'ABCDEF'[i])
              ? { borderColor: 'var(--accent)', background: 'var(--accent-weak)' }
              : {}"
          @click="!redo.revealed && toggleR(rq.type === 'judge' ? opt : 'ABCDEF'[i])"
        >
          <b>{{ rq.type === 'judge' ? '' : 'ABCDEF'[i] + '.' }}</b>
          <span style="flex: 1">{{ opt }}</span>
          <span v-if="redo.revealed && rq.answer.includes(rq.type === 'judge' ? opt : 'ABCDEF'[i])" class="tag green">答案</span>
        </button>
      </div>
      <div v-else style="margin-bottom: 16px">
        <textarea class="input" rows="4" v-model="rTyped" :disabled="redo.revealed" placeholder="输入答案"></textarea>
      </div>

      <div v-if="redo.revealed" class="card" style="margin-bottom: 14px" :style="{ borderColor: rRight ? 'var(--green)' : 'var(--red)' }">
        <span class="tag" :class="rRight ? 'green' : 'red'">{{ rRight ? '答对了' : '还是错了' }}</span>
        <b v-if="!rRight" style="margin-left: 8px">正确答案：{{ rq.answer.join('、') }}</b>
        <div class="tiny" style="margin-top: 6px">掌握由记忆排期判定 —— {{ masteredHint(redo.list[redo.idx].card) }}</div>
        <div v-if="rq.analysis" class="muted" style="margin-top: 6px; white-space: pre-wrap">解析：{{ rq.analysis }}</div>
        <div style="margin-top: 10px">
          <AiTutor :question="rq" :chosen="rChosen" />
        </div>
      </div>

      <button v-if="!redo.revealed" class="btn block" :disabled="!rChosen.length && rq.type !== 'essay' && rq.type !== 'fill'" @click="submitRedo">提交</button>
      <button v-else class="btn block" @click="nextRedo">{{ redo.idx + 1 >= redo.list.length ? '完成' : '下一题' }}</button>
    </template>

    <!-- ===== 错题列表 ===== -->
    <template v-else>
      <div class="page-head row between wrap">
        <div>
          <h1>错题本</h1>
          <div class="sub">按错因归类；是否掌握由记忆排期判定（连对 {{ MASTERED_REPS }} 次或间隔 {{ MASTERED_DAYS }} 天自动移出）</div>
        </div>
        <button class="btn" :disabled="!shown.length" @click="startRedo">
          {{ reasonFilter ? `开始「${reasonFilter}」专项（${shown.length}）` : `重做错题（${shown.length}）` }}
        </button>
      </div>

      <div class="row wrap" style="margin-bottom: 14px">
        <button class="btn sm" :class="{ ghost: filter !== 'active' }" @click="filter = 'active'; reload()">待复习</button>
        <button class="btn sm" :class="{ ghost: filter !== 'cleared' }" @click="filter = 'cleared'; reload()">已掌握</button>
        <span style="flex: 1"></span>
        <button class="btn sm ghost" :class="{ }" :style="reasonFilter === '' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}" @click="reasonFilter = ''">全部</button>
        <button
          v-for="r in REASONS"
          :key="r"
          class="btn sm ghost"
          :style="reasonFilter === r ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}"
          @click="reasonFilter = reasonFilter === r ? '' : r"
        >{{ r }}</button>
      </div>

      <!-- 错因专项入口 -->
      <div v-if="reasonFilter && filter === 'active'" class="card" style="margin-bottom: 14px; border-color: var(--accent); background: var(--accent-weak)">
        <div class="row between wrap">
          <div>
            <b style="color: var(--accent)">「{{ reasonFilter }}」错因专项</b>
            <div class="tiny" style="margin-top: 2px">
              从 {{ shown.length }} 道因「{{ reasonFilter }}」而出错的题开始集中突破，答对会推进记忆间隔，连对 {{ MASTERED_REPS }} 次或间隔满 {{ MASTERED_DAYS }} 天自动移出
            </div>
          </div>
          <button class="btn" :disabled="!shown.length" @click="startRedo">开始专项练习</button>
        </div>
      </div>

      <div v-if="filter === 'active' && reasonStats.length" class="card" style="margin-bottom: 14px">
        <div class="tiny" style="margin-bottom: 8px">错因分布（点击可筛选并开启专项）</div>
        <div class="row wrap" style="gap: 8px">
          <button
            class="tag"
            v-for="[r, n] in reasonStats"
            :key="r"
            style="cursor: pointer; border: none"
            :style="reasonFilter === r ? 'background: var(--accent); color: #fff' : ''"
            @click="reasonFilter = reasonFilter === r ? '' : r"
          >{{ r }} × {{ n }}</button>
        </div>
      </div>

      <div v-if="!shown.length" class="card empty">
        <div class="ico-wrap" style="color: var(--green)"><Icon name="check" :size="30" /></div>
        <p>{{ filter === 'active' ? '没有待复习的错题' : '还没有已掌握的错题' }}</p>
      </div>

      <div v-for="item in shown" :key="item.w.id" class="card" style="margin-bottom: 12px">
        <div class="row between wrap" style="margin-bottom: 8px">
          <span class="tiny">
            错 {{ item.w.wrongCount }} 次 · {{ item.q.chapter || '未分类' }}
            <template v-if="item.card"> · 连对 {{ item.card.reps || 0 }} 次 / 间隔 {{ item.card.intervalDays || 0 }} 天</template>
            <template v-if="item.w.clearedBy === 'user'"> · 手动标注掌握</template>
          </span>
          <div class="row" style="gap: 6px">
            <button class="btn ghost sm" @click="remove(item)">移除</button>
            <button v-if="filter === 'active'" class="btn ghost sm" @click="markCleared(item)">标记掌握</button>
            <button v-else class="btn ghost sm" @click="reopen(item)">重新纳入</button>
          </div>
        </div>
        <div style="font-weight: 600; white-space: pre-wrap; margin-bottom: 8px">{{ item.q.stem.slice(0, 160) }}</div>
        <div class="row wrap" style="gap: 6px">
          <button
            v-for="r in REASONS"
            :key="r"
            class="btn sm ghost"
            :style="(item.w.wrongReasons || []).includes(r) ? { borderColor: 'var(--accent)', background: 'var(--accent-weak)', color: 'var(--accent)' } : {}"
            @click="toggleReason(item, r)"
          >{{ r }}</button>
        </div>
      </div>
    </template>
  </div>
</template>
