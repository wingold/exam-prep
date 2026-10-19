<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import db, { uid, now } from '../db'
import { isCorrect, isKeyQuestion } from '../importers'
import { enrollCard } from '../srs'
import { scheduleSync } from '../sync'

const route = useRoute()
const router = useRouter()

const banks = ref([])
const bankId = ref('')
const customCount = ref(10)
const timeLimit = ref(30) // 分钟
const chapters = ref([])
const chapterFilter = ref('')
const keyOnly = ref(false)

// 考试会话
const exam = ref(null) // { paperId, questions, answers, flags, deadlineAt }
const remain = ref(0)
const tick = ref(null)
const submitted = ref(false)

const reports = ref([])

/* ===== 续考草稿 =====
   模考中途被杀进程 / 切走太久，原来的 answers 全在组件内存里，重进就没了。
   这里把答案、标记、当前题和「截止时间」写进 localStorage：
   存 deadlineAt 而不是「剩余秒数」，避免关掉应用的那段时间不算在倒计时里。 */
const DRAFT_KEY = 'exam_draft_v1'
const draftInfo = ref(null) // { total, answered, remainSec, expired, startedAt, questions: [...] }
let saveTimer = null

function saveDraft() {
  if (!exam.value || submitted.value) return
  const e = exam.value
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      paperId: e.paperId,
      bankId: bankId.value || e.questions[0]?.bankId || '',
      questionIds: e.questions.map((q) => q.id),
      answers: e.answers,
      typed: e.typed,
      flags: e.flags,
      idx: e.idx,
      startedAt: e.startedAt,
      timeLimitMin: e.timeLimitMin,
      deadlineAt: e.deadlineAt,
    }))
  } catch { /* 存储写满或被禁用时静默降级，不影响本次考试 */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY) } catch { /* 同上 */ }
  draftInfo.value = null
}

watch(exam, () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveDraft, 250)
}, { deep: true })

async function detectDraft() {
  let d = null
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') } catch { d = null }
  if (!d || !Array.isArray(d.questionIds) || !d.questionIds.length) return
  const qs = (await Promise.all(d.questionIds.map((id) => db.questions.get(id)))).filter(Boolean)
  // 题目被删（题库清空/换设备合并）时草稿已经没有意义，直接丢弃
  if (!qs.length) return clearDraft()
  const answered = qs.filter((q) =>
    (d.answers?.[q.id] || []).length > 0 || (d.typed?.[q.id] || '').trim().length > 0
  ).length
  const remainSec = Math.max(0, Math.round(((d.deadlineAt || 0) - Date.now()) / 1000))
  draftInfo.value = {
    raw: d,
    questions: qs,
    total: qs.length,
    answered,
    remainSec,
    expired: remainSec <= 0,
  }
}

onMounted(async () => {
  banks.value = await db.banks.orderBy('createdAt').reverse().toArray()
  if (route.query.bank) bankId.value = route.query.bank
  reports.value = await db.results.orderBy('at').reverse().limit(20).toArray()
  await detectDraft()
  if (route.query.result) {
    const r = reports.value.find((x) => x.id === route.query.result)
    if (r) viewReport(r)
  }
})

async function onBankChange() {
  chapters.value = []
  chapterFilter.value = ''
  if (!bankId.value) return
  const qs = await db.questions.where('bankId').equals(bankId.value).toArray()
  chapters.value = [...new Set(qs.map((q) => q.chapter).filter(Boolean))]
}

async function startExam() {
  let qs = await db.questions.where('bankId').equals(bankId.value).sortBy('seq')
  if (keyOnly.value) qs = qs.filter((q) => isKeyQuestion(q))
  if (chapterFilter.value) qs = qs.filter((q) => q.chapter === chapterFilter.value)
  if (!qs.length) return alert(keyOnly.value ? '没有符合条件的重点题' : '没有符合条件的题目')
  // 抽题：不足数量全取，否则随机抽
  const n = Math.min(customCount.value, qs.length)
  const picked = qs.length <= customCount.value ? qs : [...qs].sort(() => Math.random() - 0.5).slice(0, n)

  const paperId = uid()
  await db.papers.put({
    id: paperId,
    bankId: bankId.value,
    questionIds: picked.map((q) => q.id),
    chapter: chapterFilter.value,
    timeLimitMin: timeLimit.value,
    createdAt: now(),
  })
  exam.value = {
    paperId,
    questions: picked,
    answers: {},
    typed: {},
    flags: {},
    idx: 0,
    startedAt: now(),
    timeLimitMin: timeLimit.value,
    deadlineAt: now() + timeLimit.value * 60 * 1000,
  }
  submitted.value = false
  clearDraft()
  startTick()
}

/* 倒计时以 deadlineAt 为准：后台被系统冻结、熄屏、切走再回来，
   都会按真实时间校正，不会因为定时器被节流而多给时间 */
function syncRemain() {
  if (!exam.value) return
  remain.value = Math.max(0, Math.round((exam.value.deadlineAt - Date.now()) / 1000))
}

function startTick() {
  clearInterval(tick.value)
  syncRemain()
  tick.value = setInterval(() => {
    syncRemain()
    if (remain.value <= 0) finish()
  }, 1000)
}

/* 恢复草稿：超时的直接按已答内容交卷，未超时的继续作答 */
function resumeDraft() {
  const d = draftInfo.value
  if (!d) return
  const raw = d.raw
  exam.value = {
    paperId: raw.paperId,
    questions: d.questions,
    answers: raw.answers || {},
    typed: raw.typed || {},
    flags: raw.flags || {},
    idx: Math.min(raw.idx || 0, d.questions.length - 1),
    startedAt: raw.startedAt || now(),
    timeLimitMin: raw.timeLimitMin || 30,
    deadlineAt: raw.deadlineAt || now(),
  }
  if (raw.bankId) bankId.value = raw.bankId
  submitted.value = false
  draftInfo.value = null
  if (d.expired) {
    // 考试时间已经用完了，直接按已答内容判分，而不是再给一轮时间
    remain.value = 0
    finish()
    return
  }
  startTick()
}

/* 暂存并退出：保留排期与答案，回到总览；下次进考试页会提示恢复 */
function suspendExam() {
  saveDraft()
  clearInterval(tick.value)
  exam.value = null
  submitted.value = false
  router.push('/')
}

const cur = computed(() => (exam.value ? exam.value.questions[exam.value.idx] : null))
const curChosen = computed(() => (cur.value ? exam.value.answers[cur.value.id] || [] : []))

function toggle(letter) {
  const q = cur.value
  const arr = exam.value.answers[q.id] ? [...exam.value.answers[q.id]] : []
  if (q.type === 'multi') {
    const i = arr.indexOf(letter)
    i >= 0 ? arr.splice(i, 1) : arr.push(letter)
  } else {
    arr.length = 0
    arr.push(letter)
  }
  exam.value.answers[q.id] = arr
}

function answered(qid) {
  return (exam.value.answers[qid] || []).length > 0 || (exam.value.typed[qid] || '').trim().length > 0
}

const answeredCount = computed(() => exam.value ? exam.value.questions.filter((q) => answered(q.id)).length : 0)

function fmt(s) {
  const m = Math.floor(Math.abs(s) / 60)
  const sec = Math.abs(s) % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

async function finish() {
  if (!exam.value || submitted.value) return
  submitted.value = true
  clearInterval(tick.value)
  const e = exam.value
  let right = 0
  const perChapter = {}
  const wrongQids = []
  for (const q of e.questions) {
    let chosen = e.answers[q.id] || []
    if (q.type === 'fill' || q.type === 'essay') chosen = [(e.typed[q.id] || '').trim()]
    const ok = isCorrect(q, chosen)
    if (ok) right++
    else wrongQids.push(q.id)
    const ch = q.chapter || '未分类'
    perChapter[ch] = perChapter[ch] || { total: 0, right: 0 }
    perChapter[ch].total++
    if (ok) perChapter[ch].right++
    await db.attempts.put({
      id: uid(), questionId: q.id, bankId: q.bankId, mode: 'exam',
      chosen: [...chosen], correct: ok, at: now(),
    })
    if (!ok) {
      const exist = await db.wrongItems.where('questionId').equals(q.id).first()
      if (exist) {
        await db.wrongItems.update(exist.id, { wrongCount: (exist.wrongCount || 1) + 1, status: 'active', rightStreak: 0, updatedAt: now() })
      } else {
        await db.wrongItems.put({ id: uid(), questionId: q.id, wrongReasons: [], wrongCount: 1, rightStreak: 0, status: 'active', updatedAt: now() })
      }
      await enrollCard(q.id, { lapsed: true })
    }
  }
  const total = e.questions.length
  const result = {
    id: uid(),
    paperId: e.paperId,
    bankId: e.questions[0]?.bankId,
    total,
    right,
    wrong: total - right,
    rate: total ? Math.round((right / total) * 100) : 0,
    durationSec: Math.min(e.timeLimitMin * 60, Math.max(0, Math.round((Date.now() - e.startedAt) / 1000))),
    perChapter,
    wrongQids,
    at: now(),
  }
  await db.results.put(result)
  reports.value = await db.results.orderBy('at').reverse().limit(20).toArray()
  // 交卷后延迟同步：一次考试几十条作答记录，别等下一次启动才上传
  scheduleSync(10000)
  clearDraft()
  viewReport(result)
  exam.value = null
}

function abandon() {
  if (!confirm('放弃本次考试？成绩不会记录，已答内容也会清空。')) return
  clearInterval(tick.value)
  clearDraft()
  exam.value = null
  submitted.value = false
}

/* ---- 报告 ---- */
const report = ref(null)
const reportQs = ref([])
const showReport = ref(false)

async function viewReport(r) {
  report.value = r
  const paper = await db.papers.get(r.paperId)
  reportQs.value = paper
    ? (await Promise.all(paper.questionIds.map((id) => db.questions.get(id)))).filter(Boolean)
    : []
  showReport.value = true
}

const chapterRows = computed(() => {
  if (!report.value) return []
  return Object.entries(report.value.perChapter || {}).map(([ch, v]) => ({
    ch, ...v, rate: v.total ? Math.round((v.right / v.total) * 100) : 0,
  }))
})

// 历史平均对比
const avgCompare = computed(() => {
  if (!report.value) return null
  const hist = reports.value.filter((r) => r.id !== report.value.id && r.bankId === report.value.bankId)
  if (hist.length < 2) return null
  const avg = hist.reduce((s, r) => s + r.rate, 0) / hist.length
  return { avg: Math.round(avg), delta: report.value.rate - Math.round(avg) }
})

function quitExam() {
  showReport.value = false
  report.value = null
}

onUnmounted(() => {
  clearInterval(tick.value)
  // 组件卸载前的最后一次落盘：正常路由跳走时保住刚才那一题的答案
  saveDraft()
})
</script>

<template>
  <div>
    <!-- ===== 报告 ===== -->
    <template v-if="showReport && report">
      <div class="page-head row between">
        <div>
          <h1>考试报告</h1>
          <div class="sub">{{ new Date(report.at).toLocaleString() }}</div>
        </div>
        <button class="btn ghost" @click="quitExam">返回</button>
      </div>

      <div class="grid3" style="margin-bottom: 16px">
        <div class="card" style="text-align: center; padding: 24px">
          <div class="bignum" :style="{ color: report.rate >= 60 ? 'var(--green)' : 'var(--red)' }">{{ report.rate }}%</div>
          <div class="muted" style="margin-top: 6px">正确率</div>
        </div>
        <div class="card" style="text-align: center; padding: 24px">
          <div class="bignum">{{ report.right }}<span style="font-size: 18px; color: var(--ink-3)">/{{ report.total }}</span></div>
          <div class="muted" style="margin-top: 6px">答对题数</div>
        </div>
        <div class="card" style="text-align: center; padding: 24px">
          <div class="bignum" style="color: var(--amber)">{{ Math.floor(report.durationSec / 60) }}<span style="font-size: 18px">分</span></div>
          <div class="muted" style="margin-top: 6px">用时</div>
        </div>
      </div>

      <div v-if="avgCompare" class="card" style="margin-bottom: 16px">
        <span class="muted">与历史平均对比：平均 {{ avgCompare.avg }}%，本次</span>
        <b :style="{ color: avgCompare.delta >= 0 ? 'var(--green)' : 'var(--red)', marginLeft: 6 }">
          {{ avgCompare.delta >= 0 ? '+' : '' }}{{ avgCompare.delta }}%
        </b>
      </div>

      <div class="card" style="margin-bottom: 16px">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 10px">分章节表现</h3>
        <table class="tbl">
          <thead><tr><th>章节</th><th>对 / 总</th><th>正确率</th></tr></thead>
          <tbody>
            <tr v-for="r in chapterRows" :key="r.ch">
              <td>{{ r.ch }}</td>
              <td>{{ r.right }} / {{ r.total }}</td>
              <td style="width: 40%">
                <div class="row" style="gap: 8px">
                  <div class="bar" style="flex: 1"><i :class="{ green: r.rate >= 70, amber: r.rate < 70 && r.rate >= 50 }" :style="{ width: r.rate + '%' }"></i></div>
                  <span class="tiny" style="width: 36px">{{ r.rate }}%</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card" v-if="report.wrongQids?.length">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 10px">错题（{{ report.wrongQids.length }}）已加入错题本</h3>
        <router-link to="/wrong"><button class="btn ghost sm">去错题本复习</button></router-link>
      </div>
    </template>

    <!-- ===== 考试中 ===== -->
    <template v-else-if="exam && cur">
      <div class="row between" style="margin-bottom: 14px">
        <span class="tiny">{{ exam.idx + 1 }} / {{ exam.questions.length }} · 已答 {{ answeredCount }}</span>
        <span
          class="tag"
          :class="remain < 300 ? 'red' : 'accent'"
          style="font-size: 16px; font-weight: 700; padding: 4px 14px"
        >⏱ {{ fmt(remain) }}</span>
      </div>

      <div class="bar" style="margin-bottom: 16px">
        <i :style="{ width: (answeredCount / exam.questions.length * 100) + '%' }"></i>
      </div>

      <div class="card" style="margin-bottom: 14px">
        <div class="row between" style="margin-bottom: 8px">
          <span class="tiny">{{ cur.chapter || '' }}</span>
          <div class="row" style="gap: 8px">
            <span class="tag red" v-if="isKeyQuestion(cur)">重点</span>
            <button class="btn ghost sm" @click="exam.flags[cur.id] = !exam.flags[cur.id]">
              {{ exam.flags[cur.id] ? '★ 已标记' : '☆ 标记存疑' }}
            </button>
            <span class="tag">{{ { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '简答' }[cur.type] }}</span>
          </div>
        </div>
        <div style="font-size: 16px; font-weight: 600; white-space: pre-wrap">{{ exam.idx + 1 }}. {{ cur.stem }}</div>
      </div>

      <div v-if="['single', 'multi', 'judge'].includes(cur.type)" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px">
        <button
          v-for="(opt, i) in (cur.type === 'judge' && !cur.options.length ? ['对', '错'] : cur.options)"
          :key="i"
          class="card row"
          style="padding: 13px 16px; text-align: left; cursor: pointer; gap: 12px"
          :style="curChosen.includes(cur.type === 'judge' ? opt : 'ABCDEF'[i]) ? { borderColor: 'var(--accent)', background: 'var(--accent-weak)' } : {}"
          @click="toggle(cur.type === 'judge' ? opt : 'ABCDEF'[i])"
        >
          <b>{{ cur.type === 'judge' ? '' : 'ABCDEF'[i] + '.' }}</b>
          <span style="flex: 1">{{ opt }}</span>
        </button>
      </div>
      <div v-else style="margin-bottom: 16px">
        <textarea class="input" rows="4" v-model="exam.typed[cur.id]" placeholder="输入答案"></textarea>
      </div>

      <div class="row between">
        <button class="btn ghost" :disabled="exam.idx === 0" @click="exam.idx--">上一题</button>
        <div class="row" style="gap: 8px">
          <button v-if="exam.idx + 1 < exam.questions.length" class="btn" @click="exam.idx++">下一题</button>
          <button class="btn danger" @click="finish">交卷</button>
        </div>
      </div>

      <!-- 答题卡 -->
      <div class="card" style="margin-top: 16px">
        <div class="tiny" style="margin-bottom: 8px">答题卡</div>
        <div class="row wrap" style="gap: 6px">
          <button
            v-for="(q, i) in exam.questions"
            :key="q.id"
            class="btn sm"
            :style="exam.idx === i
              ? { background: 'var(--accent)' }
              : answered(q.id)
                ? { background: 'var(--green-weak)', color: 'var(--green)' }
                : { background: 'var(--bg)', color: 'var(--ink-2)' }"
            @click="exam.idx = i"
          >{{ i + 1 }}</button>
        </div>
        <div class="row wrap" style="margin-top: 12px; gap: 8px">
          <button class="btn ghost sm" @click="suspendExam">暂存并退出</button>
          <button class="btn ghost sm" @click="abandon">放弃考试</button>
        </div>
        <div class="tiny" style="margin-top: 8px; color: var(--ink-3)">
          中途退出或被系统回收都会自动暂存，下次进考试页可继续作答，倒计时按真实时间计算。
        </div>
      </div>
    </template>

    <!-- ===== 组卷 ===== -->
    <template v-else>
      <div class="page-head">
        <h1>模拟考试</h1>
        <div class="sub">限时作答，交卷生成报告</div>
      </div>

      <!-- 续考提示：上次没做完的考试还留着答案与剩余时间 -->
      <div
        v-if="draftInfo"
        class="card"
        style="margin-bottom: 16px; border-color: var(--accent); background: var(--accent-weak)"
      >
        <div class="row between wrap" style="gap: 12px; align-items: flex-start">
          <div style="min-width: 0; flex: 1">
            <div style="font-size: 14px; font-weight: 700">
              {{ draftInfo.expired ? '上次考试已超时' : '上次考试未完成' }}
            </div>
            <div class="tiny" style="margin-top: 5px; line-height: 1.7">
              已答 {{ draftInfo.answered }} / {{ draftInfo.total }} 题 ·
              {{ draftInfo.expired ? '限时已用完' : `剩余 ${fmt(draftInfo.remainSec)}` }}<br />
              {{ draftInfo.expired
                ? '可以按已答内容交卷计入成绩，也可以放弃这次考试。'
                : '答案、标记存疑和倒计时都已保留，继续作答即可。' }}
            </div>
          </div>
          <div class="row" style="gap: 8px">
            <button class="btn ghost sm" @click="clearDraft">放弃</button>
            <button class="btn sm" @click="resumeDraft">
              {{ draftInfo.expired ? '按已答内容交卷' : '继续作答' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="!banks.length" class="card empty">
        <div class="big">⏱</div>
        <p>先导入题库</p>
        <router-link to="/banks"><button class="btn">去导入</button></router-link>
      </div>

      <div v-else class="card" style="max-width: 560px">
        <label class="field">
          <span class="lab">题库</span>
          <select class="input" v-model="bankId" @change="onBankChange">
            <option value="" disabled>请选择</option>
            <option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </label>

        <label v-if="chapters.length" class="field">
          <span class="lab">章节（可选）</span>
          <select class="input" v-model="chapterFilter">
            <option value="">全部章节</option>
            <option v-for="c in chapters" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>

        <div class="grid2">
          <label class="field">
            <span class="lab">题目数量</span>
            <input class="input" type="number" min="1" v-model.number="customCount" />
          </label>
          <label class="field">
            <span class="lab">时长（分钟）</span>
            <input class="input" type="number" min="1" v-model.number="timeLimit" />
          </label>
        </div>

        <label class="row" style="margin-bottom: 12px; cursor: pointer; font-size: 14px">
          <input type="checkbox" v-model="keyOnly" />
          <span>只抽<b style="color: var(--red)">重点</b>题</span>
        </label>

        <button class="btn block" :disabled="!bankId" @click="startExam">开始考试</button>
      </div>

      <!-- 历史报告 -->
      <div v-if="reports.length" class="card" style="margin-top: 16px">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 10px">历史成绩</h3>
        <table class="tbl">
          <thead><tr><th>时间</th><th>成绩</th><th>对/总</th><th>用时</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in reports" :key="r.id">
              <td class="tiny">{{ new Date(r.at).toLocaleString() }}</td>
              <td><b :style="{ color: r.rate >= 60 ? 'var(--green)' : 'var(--red)' }">{{ r.rate }}%</b></td>
              <td>{{ r.right }}/{{ r.total }}</td>
              <td class="tiny">{{ Math.floor(r.durationSec / 60) }}分</td>
              <td><button class="btn ghost sm" @click="viewReport(r)">查看</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
