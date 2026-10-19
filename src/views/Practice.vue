<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import db, { uid, now } from '../db'
import { isCorrect, isKeyQuestion } from '../importers'
import { dueCards, enrollCard, rateCard, dueCount, previewIntervals, intervalLabel, refreshExamCap } from '../srs'
import { scheduleSync } from '../sync'
import { getPrefs } from '../prefs'
import Icon from '../components/Icon.vue'
import AiTutor from '../components/AiTutor.vue'

const route = useRoute()
const router = useRouter()

const banks = ref([])
const bankId = ref('')
const mode = ref('order') // order | random | chapter | unfinished | review | key
const chapters = ref([])
const chapter = ref('')
const keyOnly = ref(false) // 所有练习/考试模式下只抽重点题
const ready = ref(false)
const due = ref(0)
const cardCount = ref(0)
const wrongTotal = ref(0)
const enrolledNow = ref({}) // qid -> true（本题已手动加入）
const keyCount = ref(0)
const nextDueText = ref('') // 今天没有到期卡时，显示最近一张的到期日
const examDays = ref(null) // 距最近考试天数；null = 没有未来考期
const autoEnroll = ref(getPrefs().autoEnroll)

// 会话状态
const session = ref(null) // { questions, idx, answers: {qid: [..]}, revealed }
const finished = ref(false)
const result = computed(() => {
  if (!finished.value || !session.value) return null
  const qs = session.value.questions
  let right = 0
  qs.forEach((q) => {
    if (isCorrect(q, session.value.answers[q.id])) right++
  })
  return { total: qs.length, right, wrong: qs.length - right, rate: qs.length ? Math.round((right / qs.length) * 100) : 0 }
})

onMounted(async () => {
  banks.value = await db.banks.orderBy('createdAt').reverse().toArray()
  due.value = await dueCount()
  await refreshNextDue()
  examDays.value = await refreshExamCap()
  cardCount.value = await db.cards.count()
  wrongTotal.value = await db.wrongItems.where('status').equals('active').count()
  if (route.query.bank && banks.value.some((b) => b.id === route.query.bank)) {
    bankId.value = route.query.bank
  }
  if (route.query.mode === 'review') mode.value = 'review'
  ready.value = true
})

watch(bankId, async (id) => {
  chapters.value = []
  chapter.value = ''
  keyCount.value = 0
  if (!id) return
  const qs = await db.questions.where('bankId').equals(id).toArray()
  chapters.value = [...new Set(qs.map((q) => q.chapter).filter(Boolean))]
  keyCount.value = qs.filter((q) => isKeyQuestion(q)).length
})

async function start() {
  if (mode.value === 'review') {
    const dueList = await dueCards()
    if (!dueList.length) {
      alert(
        cardCount.value
          ? '今天没有到期的复习卡片。间隔复习不会天天有——可以先去练习刷题，答错的题会自动入队。'
          : '还没有题卡。答题时点「加入题卡复习」，或在上方把错题本一键入队。'
      )
      return
    }
    session.value = {
      questions: dueList.map((d) => d.q),
      cards: Object.fromEntries(dueList.map((d) => [d.q.id, d.card])),
      review: true,
      idx: 0,
      answers: {},
      revealed: false,
      startedAt: now(),
    }
    finished.value = false
    return
  }
  if (!bankId.value) return
  let qs = await db.questions.where('bankId').equals(bankId.value).sortBy('seq')

  if (keyOnly.value) {
    qs = qs.filter((q) => isKeyQuestion(q))
  }
  if (mode.value === 'chapter' && chapter.value) {
    qs = qs.filter((q) => q.chapter === chapter.value)
  }
  if (mode.value === 'random') {
    qs = [...qs].sort(() => Math.random() - 0.5)
  }
  if (mode.value === 'unfinished') {
    const attempts = await db.attempts.where('bankId').equals(bankId.value).toArray()
    const done = new Set(attempts.map((a) => a.questionId))
    qs = qs.filter((q) => !done.has(q.id))
  }
  if (!qs.length) {
    alert(keyOnly.value ? '该条件下没有重点题（题库导入时未标记或不存在）' : '该条件下没有题目')
    return
  }
  session.value = { questions: qs, idx: 0, answers: {}, revealed: false, startedAt: now() }
  finished.value = false
}

const cur = computed(() => (session.value ? session.value.questions[session.value.idx] : null))
const curChosen = computed(() => (cur.value ? session.value.answers[cur.value.id] || [] : []))

function toggleChoice(letter) {
  if (!cur.value || session.value.revealed) return
  const q = cur.value
  const arr = session.value.answers[q.id] ? [...session.value.answers[q.id]] : []
  if (q.type === 'multi') {
    const i = arr.indexOf(letter)
    i >= 0 ? arr.splice(i, 1) : arr.push(letter)
  } else {
    arr.length = 0
    arr.push(letter)
  }
  session.value.answers[q.id] = arr
}

const typedAnswer = ref('')

function submit() {
  if (!cur.value) return
  const q = cur.value
  if (q.type === 'fill' || q.type === 'essay') {
    session.value.answers[q.id] = [typedAnswer.value]
  }
  if (!(session.value.answers[q.id] || []).length && q.type !== 'essay') return
  session.value.revealed = true
  recordAttempt()
}

async function recordAttempt() {
  const q = cur.value
  const chosen = session.value.answers[q.id] || []
  const ok = isCorrect(q, chosen)
  await db.attempts.put({
    id: uid(),
    questionId: q.id,
    bankId: q.bankId,
    mode: 'practice',
    chosen: [...chosen],
    correct: ok,
    at: now(),
  })
  if (!ok) {
    await addWrong(q.id, [])
    await enrollCard(q.id, { lapsed: true })
  }
  // 作答后延迟同步（合并触发，不打断答题）；未配 WebDAV 时内部直接返回
  scheduleSync()
}

async function addReason(questionId, reason) {
  const existing = await db.wrongItems.where('questionId').equals(questionId).first()
  if (!existing) return
  const next = [...new Set([...(existing.wrongReasons || []), reason])]
  await db.wrongItems.update(existing.id, { wrongReasons: next, updatedAt: now() })
}

async function addWrong(questionId, reasons) {
  const existing = await db.wrongItems.where('questionId').equals(questionId).first()
  if (existing) {
    await db.wrongItems.update(existing.id, {
      wrongCount: (existing.wrongCount || 1) + 1,
      status: 'active',
      rightStreak: 0,
      updatedAt: now(),
      wrongReasons: [...new Set([...(existing.wrongReasons || []), ...reasons])],
    })
  } else {
    await db.wrongItems.put({
      id: uid(),
      questionId,
      wrongReasons: reasons,
      wrongCount: 1,
      rightStreak: 0,
      status: 'active',
      updatedAt: now(),
    })
  }
}

function next() {
  session.value.revealed = false
  typedAnswer.value = ''
  if (session.value.idx + 1 >= session.value.questions.length) {
    finished.value = true
  } else {
    session.value.idx++
  }
}

/* 今天没有到期卡时，查最近一张的到期日，避免"0 张"让人以为功能失效 */
async function refreshNextDue() {
  if (due.value) {
    nextDueText.value = ''
    return
  }
  const c = await db.cards.orderBy('dueAt').first()
  nextDueText.value = c
    ? new Date(c.dueAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    : ''
}

/* 记忆复习评分：不认识 / 模糊 / 认识 */
async function rate(r) {
  await rateCard(cur.value.id, r)
  due.value = await dueCount()
  await refreshNextDue()
  scheduleSync()
  next()
}

/* 手动把当前题加入记忆卡：force 绕过设置页的自动入队开关 */
async function enrollCurrent() {
  await enrollCard(cur.value.id, { force: true })
  enrolledNow.value = { ...enrolledNow.value, [cur.value.id]: true }
  due.value = await dueCount()
  await refreshNextDue()
  cardCount.value = await db.cards.count()
}

/* 把错题本里的活跃错题批量加入记忆卡 */
async function enrollAllWrongs() {
  const wrongs = await db.wrongItems.where('status').equals('active').toArray()
  for (const w of wrongs) await enrollCard(w.questionId, { force: true })
  due.value = await dueCount()
  await refreshNextDue()
  cardCount.value = await db.cards.count()
  alert(`已把 ${wrongs.length} 道错题加入题卡复习，明天起按间隔到期`)
}

function quit() {
  if (confirm('退出练习？本次已作答的记录会保留。')) {
    session.value = null
    finished.value = false
  }
}

const isRight = computed(() => cur.value ? isCorrect(cur.value, curChosen.value) : false)

/* 当前卡三档评分分别推到多久：直接显示在按钮上 */
const nextPreview = computed(() => {
  if (!session.value?.review || !cur.value) return null
  return previewIntervals(session.value.cards?.[cur.value.id])
})

function optionState(letter) {
  if (!session.value?.revealed) {
    return curChosen.value.includes(letter) ? 'chosen' : ''
  }
  const right = cur.value.answer.map((x) => x.toUpperCase()).includes(letter.toUpperCase())
  const chosen = curChosen.value.includes(letter)
  if (right) return 'right'
  if (chosen && !right) return 'wrong'
  return ''
}

const modeNames = { order: '顺序练习', random: '随机练习', chapter: '章节专项', unfinished: '未做题快练', review: '题卡复习' }
</script>

<template>
  <div>
    <!-- ===== 未开始：模式选择 ===== -->
    <template v-if="!session">
      <div class="page-head">
        <h1>练习</h1>
        <div class="sub">选题库和模式，开始刷题</div>
      </div>

      <div v-if="!banks.length" class="card empty">
        <div class="ico-wrap"><Icon name="pencil" :size="28" /></div>
        <p>先导入题库才能开始练习</p>
        <router-link to="/banks"><button class="btn">去导入题库</button></router-link>
      </div>

      <div v-else class="card" style="max-width: 560px">
        <label v-if="mode !== 'review'" class="field">
          <span class="lab">选择题库</span>
          <select class="input" v-model="bankId">
            <option value="" disabled>请选择</option>
            <option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </label>

        <div class="lab" style="font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 6px">练习模式</div>
        <div class="grid2" style="margin-bottom: 8px">
          <button
            v-for="(label, key) in modeNames"
            :key="key"
            class="card"
            style="padding: 14px; text-align: left; cursor: pointer"
            :style="mode === key ? 'border-color: var(--accent); background: var(--accent-weak)' : ''"
            @click="mode = key"
          >
            <b style="font-size: 14px">{{ label }}</b>
            <div v-if="key === 'review'" class="tiny" style="margin-top: 2px">
              今日到期 {{ due }} 张 · 共 {{ cardCount }} 张
            </div>
          </button>
        </div>

        <!-- 题卡复习使用说明 -->
        <div v-if="mode === 'review'" class="card" style="padding: 12px 14px; background: var(--accent-weak); border-color: transparent; margin-bottom: 8px">
          <div class="tiny" style="line-height: 1.7; color: var(--ink-2)">
            <b style="color: var(--accent)">题卡（复习的是题目，不是知识点卡片）：</b><br />
            ① <template v-if="autoEnroll">练习/模考答错的题<b>自动入队</b>，今天答错明天就会到期；</template>
            <template v-else><span style="color: var(--amber)">设置页已关闭自动入队</span>，答错只进错题本；</template><br />
            ② 答题后点<b>「加入题卡复习」</b>可手动把任意题加入；<br />
            ③ 一键把错题本全部转成题卡：
            <button class="btn ghost sm" style="margin-left: 6px" :disabled="!wrongTotal" @click="enrollAllWrongs">
              错题全部入队（{{ wrongTotal }}）
            </button>
            <br />
            <span style="color: var(--ink-3)">背知识点请走「卡片」页的<b>知识卡片</b>（从讲义摘取的记忆点），两套互不相通。</span>
          </div>
          <div v-if="examDays != null" class="tiny" style="margin-top: 6px; color: var(--accent)">
            距最近考试 {{ examDays }} 天 · 单卡间隔上限 {{ Math.max(1, Math.floor(examDays / 3)) }} 天（保证考前还能复习到）
          </div>
          <div v-if="!due && cardCount" class="tiny" style="margin-top: 6px">
            今天没有到期的题卡<template v-if="nextDueText">，最近一批 <b>{{ nextDueText }}</b> 到期</template>——间隔复习本来就不该天天有。
          </div>
          <div v-if="!cardCount" class="tiny" style="margin-top: 6px">
            还没有题卡，先去练几题<template v-if="autoEnroll">（答错自动入队）</template>，或用上面的按钮从错题本导入。
          </div>
        </div>

        <label v-if="mode === 'chapter'" class="field" style="margin-top: 8px">
          <span class="lab">选择章节</span>
          <select class="input" v-model="chapter">
            <option value="" disabled>请选择</option>
            <option v-for="c in chapters" :key="c" :value="c">{{ c }}</option>
          </select>
          <span v-if="!chapters.length" class="tiny">该题库没有章节标记，请选择其他模式</span>
        </label>

        <label v-if="mode !== 'review'" class="row" style="margin-top: 4px; cursor: pointer; font-size: 14px">
          <input type="checkbox" v-model="keyOnly" />
          <span>只做<b style="color: var(--red)">重点</b>题</span>
          <span class="tiny" v-if="keyCount === 0">（该题库无重点标记）</span>
          <span class="tiny" v-else>（共 {{ keyCount }} 题）</span>
        </label>

        <button class="btn block" style="margin-top: 12px" :disabled="(mode !== 'review' && !bankId) || (mode === 'chapter' && !chapter)" @click="start">
          开始练习
        </button>
      </div>
    </template>

    <!-- ===== 结果页 ===== -->
    <template v-else-if="finished">
      <div class="page-head">
        <h1>练习完成</h1>
        <div class="sub">{{ modeNames[mode] }}</div>
      </div>
      <div class="card" style="max-width: 480px; text-align: center; padding: 32px">
        <div class="bignum" :style="{ color: result.rate >= 70 ? 'var(--green)' : 'var(--amber)' }">{{ result.rate }}%</div>
        <div class="muted" style="margin-top: 8px">答对 {{ result.right }} / {{ result.total }} 题</div>
        <div class="row" style="justify-content: center; gap: 10px; margin-top: 24px">
          <button class="btn ghost" @click="session = null">返回</button>
          <button class="btn" @click="start">再来一轮</button>
          <router-link to="/wrong"><button class="btn ghost">看错题</button></router-link>
        </div>
      </div>
    </template>

    <!-- ===== 答题中 ===== -->
    <template v-else-if="cur">
      <div class="row between" style="margin-bottom: 14px">
        <div class="row" style="gap: 10px">
          <span class="tag accent">{{ modeNames[mode] }}</span>
          <span class="tiny">{{ session.idx + 1 }} / {{ session.questions.length }}</span>
        </div>
        <button class="btn ghost sm" @click="quit">退出</button>
      </div>

      <div class="bar" style="margin-bottom: 16px">
        <i :style="{ width: ((session.idx + (session.revealed ? 1 : 0)) / session.questions.length * 100) + '%' }"></i>
      </div>

      <div class="card" style="margin-bottom: 14px">
        <div class="row between" style="margin-bottom: 8px">
          <span class="tiny" v-if="cur.chapter">{{ cur.chapter }}</span>
          <div class="row" style="gap: 6px">
            <span class="tag red" v-if="isKeyQuestion(cur)">重点</span>
            <span class="tag">{{ { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '简答' }[cur.type] }}</span>
          </div>
        </div>
        <div style="font-size: 16px; font-weight: 600; white-space: pre-wrap">{{ cur.stem }}</div>
      </div>

      <!-- 选择题选项 -->
      <div v-if="['single', 'multi', 'judge'].includes(cur.type)" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px">
        <button
          v-for="(opt, i) in (cur.type === 'judge' && !cur.options.length ? ['对', '错'] : cur.options)"
          :key="i"
          class="card row"
          style="padding: 13px 16px; text-align: left; cursor: pointer; gap: 12px"
          :style="btnStyle(optionState('ABCDEF'[i] || String(i + 1)))"
          @click="toggleChoice(cur.type === 'judge' ? opt : 'ABCDEF'[i])"
        >
          <b style="flex-shrink: 0">{{ cur.type === 'judge' ? '' : 'ABCDEF'[i] + '.' }}</b>
          <span style="flex: 1">{{ opt }}</span>
          <span v-if="session.revealed && cur.answer.includes(cur.type === 'judge' ? opt : 'ABCDEF'[i])" class="tag green">正确答案</span>
        </button>
      </div>

      <!-- 填空 / 简答 -->
      <div v-else style="margin-bottom: 16px">
        <textarea
          class="input"
          rows="4"
          v-model="typedAnswer"
          :disabled="session.revealed"
          :placeholder="cur.type === 'essay' ? '写下你的答案，提交后对照参考答案' : '输入答案'"
        ></textarea>
      </div>

      <!-- 提交后反馈 -->
      <div v-if="session.revealed" class="card" style="margin-bottom: 14px" :style="{ borderColor: isRight ? 'var(--green)' : 'var(--red)' }">
        <div class="row" style="margin-bottom: 6px">
          <span class="tag" :class="isRight ? 'green' : 'red'">{{ isRight ? '答对了' : '答错了' }}</span>
          <b v-if="!isRight">正确答案：{{ cur.answer.join('、') || '（见解析）' }}</b>
        </div>
        <div v-if="cur.analysis" class="muted" style="white-space: pre-wrap">解析：{{ cur.analysis }}</div>
        <div v-if="!isRight" class="row wrap" style="margin-top: 10px; gap: 6px">
          <span class="tiny">错因（可选）：</span>
          <button class="btn ghost sm" @click="addReason(cur.id, '粗心')">粗心</button>
          <button class="btn ghost sm" @click="addReason(cur.id, '不会')">不会</button>
          <button class="btn ghost sm" @click="addReason(cur.id, '审题')">审题</button>
          <button class="btn ghost sm" @click="addReason(cur.id, '没时间')">没时间</button>
        </div>
        <div class="row wrap" style="margin-top: 10px; gap: 6px">
          <button
            class="btn sm"
            :style="enrolledNow[cur.id] || session.review ? { background: 'var(--green)' } : {}"
            :disabled="!!enrolledNow[cur.id] || session.review"
            @click="enrollCurrent"
          >
            {{ enrolledNow[cur.id] ? '已加入题卡复习 ✓' : session.review ? '已在题卡复习队列中' : '加入题卡复习（间隔复习）' }}
          </button>
          <span class="tiny" v-if="!enrolledNow[cur.id] && !session.review">按遗忘曲线安排下次复习时间；知识点背诵请用「卡片」页</span>
        </div>
        <div style="margin-top: 10px">
          <AiTutor :question="cur" :chosen="curChosen" />
        </div>
      </div>

      <button v-if="!session.revealed" class="btn block" :disabled="!curChosen.length && cur.type !== 'essay' && cur.type !== 'fill'" @click="submit">
        提交答案
      </button>

      <!-- 记忆复习：评分三键（按钮上直接显示下次复习时间） -->
      <div v-else-if="session.review" style="display: flex; gap: 10px">
        <button class="btn danger" style="flex: 1; flex-direction: column; gap: 1px; padding: 8px 10px" @click="rate('again')">
          不认识
          <span style="font-size: 11px; font-weight: 400; opacity: 0.9">{{ intervalLabel(nextPreview.again) }}</span>
        </button>
        <button class="btn ghost" style="flex: 1; flex-direction: column; gap: 1px; padding: 8px 10px; border-color: var(--amber); color: var(--amber)" @click="rate('hard')">
          模糊
          <span style="font-size: 11px; font-weight: 400; opacity: 0.9">{{ intervalLabel(nextPreview.hard) }}</span>
        </button>
        <button class="btn" style="flex: 1; flex-direction: column; gap: 1px; padding: 8px 10px; background: var(--green)" @click="rate('good')">
          认识
          <span style="font-size: 11px; font-weight: 400; opacity: 0.9">{{ intervalLabel(nextPreview.good) }}</span>
        </button>
      </div>

      <button v-else class="btn block" @click="next">
        {{ session.idx + 1 >= session.questions.length ? '完成练习' : '下一题' }}
      </button>
    </template>
  </div>
</template>

<script>
export default {
  methods: {
    btnStyle(st) {
      if (st === 'chosen') return { borderColor: 'var(--accent)', background: 'var(--accent-weak)' }
      if (st === 'right') return { borderColor: 'var(--green)', background: 'var(--green-weak)' }
      if (st === 'wrong') return { borderColor: 'var(--red)', background: 'var(--red-weak)' }
      return {}
    },
  },
}
</script>
