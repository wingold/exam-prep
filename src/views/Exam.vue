<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import db, { uid, now } from '../db'
import { isCorrect, isKeyQuestion, needsSelfEval } from '../importers'
import { typeLabel, typeHint, typeScore, TEMPLATES, DEFAULT_TEMPLATE_ID, templateById, templateTotal, templateForSubject, SELF_EVAL, evalRatio } from '../questiontypes'
import { enrollCard, rateCard } from '../srs'
import { scheduleSync } from '../sync'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()

const banks = ref([])
const bankId = ref('')
const customCount = ref(10)
const timeLimit = ref(150) // 分钟
const chapters = ref([])
const chapterFilter = ref('')
const keyOnly = ref(false)
// 组卷方式：按真题卷结构（默认）或自定义题量
const paperMode = ref('template')
// 卷面模板：各科结构不同（有的带名词解释、有的没有），按题库的科目自动匹配，也可手选
const TEMPLATE_KEY = 'exam_paper_template'
const templateId = ref(localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE_ID)
const tmpl = computed(() => templateById(templateId.value))
function setTemplate(id) {
  templateId.value = id
  localStorage.setItem(TEMPLATE_KEY, id)
}
/* 当前试卷的题型分值表（按模板走）。为空表示自定义卷或旧试卷，回落到题型默认分。 */
const scoreMap = ref(null)
const paperScore = (type) => scoreMap.value?.[type] ?? typeScore(type)
// 主观题自评：qid → 'hit' | 'half' | 'miss'
const selfEval = ref({})
const evalAttemptId = new Map() // qid → attempts.id，改档时更新同一条记录

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
  if (route.query.bank) {
    bankId.value = route.query.bank
    // 从题库页跳过来时也要把卷面模板对上
    await onBankChange()
  }
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

  // 按题库的科目 / 题库名猜卷面结构；猜不到就沿用上一次的选择
  const bank = await db.banks.get(bankId.value)
  let subjectName = ''
  if (bank?.subjectId) {
    const s = await db.subjects.get(bank.subjectId)
    subjectName = s?.name || ''
  }
  const matched = templateForSubject(subjectName, bank?.name)
  if (matched) setTemplate(matched.id)
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5)
}

/* 按所选卷面模板取题：逐类按题量抽。
   某类题不够时不静默少给，而是把缺口告诉考生，避免以为考了 100 分实际只有 60 分。 */
function pickByTemplate(qs) {
  const byType = {}
  for (const q of qs) (byType[q.type] || (byType[q.type] = [])).push(q)
  const picked = []
  const gaps = []
  for (const sec of tmpl.value.sections) {
    const pool = byType[sec.type] || []
    const n = Math.min(sec.count, pool.length)
    if (!n) gaps.push(`${typeLabel(sec.type)}：题库中没有`)
    else if (n < sec.count) gaps.push(`${typeLabel(sec.type)}：缺 ${sec.count - n} 题`)
    picked.push(...shuffle(pool).slice(0, n))
  }
  return { picked, gaps }
}

async function startExam() {
  let qs = await db.questions.where('bankId').equals(bankId.value).sortBy('seq')
  if (keyOnly.value) qs = qs.filter((q) => isKeyQuestion(q))
  if (chapterFilter.value) qs = qs.filter((q) => q.chapter === chapterFilter.value)
  if (!qs.length) return alert(keyOnly.value ? '没有符合条件的重点题' : '没有符合条件的题目')

  let picked
  if (paperMode.value === 'template') {
    const r = pickByTemplate(qs)
    if (!r.picked.length) return alert('题库里没有可用于组卷的题目')
    if (r.gaps.length && !confirm(`按「${tmpl.value.name}」组卷时缺题：\n${r.gaps.join('\n')}\n\n仍然开始考试吗？`)) return
    picked = r.picked
  } else {
    const n = Math.min(customCount.value, qs.length)
    picked = qs.length <= customCount.value ? qs : shuffle(qs).slice(0, n)
  }

  /* 各题型分值来自模板而非全局默认值：03450 的名词解释是 4 分、简答 6 分、
     论述 15 分，与通用值（3/5/10）不同。分值随试卷存库，历史报告重开时
     才不会按通用值把 100 分的卷子算成 80 分。 */
  const scores =
    paperMode.value === 'template'
      ? Object.fromEntries(tmpl.value.sections.map((s) => [s.type, s.score]))
      : null
  scoreMap.value = scores
  const paperId = uid()
  await db.papers.put({
    id: paperId,
    bankId: bankId.value,
    questionIds: picked.map((q) => q.id),
    chapter: chapterFilter.value,
    timeLimitMin: timeLimit.value,
    createdAt: now(),
    ...(scores ? { scores } : {}),
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
  selfEval.value = {}
  evalAttemptId.clear()
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
  let objTotal = 0
  let subjTotal = 0
  const perChapter = {}
  const wrongQids = []

  for (const q of e.questions) {
    // 主观题交卷时判不了分：不计入客观题正确率，也不进错题本，
    // 交卷后在报告页逐题对照参考答案自评，自评结果才决定要不要进记忆队列
    if (needsSelfEval(q)) {
      subjTotal++
      continue
    }
    objTotal++
    let chosen = e.answers[q.id] || []
    if (q.type === 'fill') chosen = [(e.typed[q.id] || '').trim()]
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

  const total = objTotal
  const result = {
    id: uid(),
    paperId: e.paperId,
    bankId: e.questions[0]?.bankId,
    total,
    right,
    wrong: total - right,
    rate: total ? Math.round((right / total) * 100) : 0,
    subjectiveTotal: subjTotal,
    selfEval: {},
    // 主观题的作答原文留着，报告页自评时要跟参考答案对着看
    typed: { ...e.typed },
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
  // 旧试卷没有存分值，回落到题型默认分
  scoreMap.value = paper?.scores || null
  // 恢复已保存的自评结果（历史报告点开时也能看到上次是怎么评的）
  selfEval.value = { ...(r.selfEval || {}) }
  evalAttemptId.clear()
  showReport.value = true
  recomputeScore()
}

/* 报告里的主观题：交卷时判不了分，需要考生对照参考答案自评 */
const subjList = computed(() => reportQs.value.filter((q) => needsSelfEval(q)))
const evalDone = computed(() => subjList.value.filter((q) => selfEval.value[q.id]).length)

/* 得分按题型的真实分值累加：客观题看对错，主观题看自评档位。
   百分制只在卷面题量与真题一致时才有意义，所以同时给出满分供参考。 */
function recomputeScore(persist = false) {
  const r = report.value
  if (!r) return
  const wrongSet = new Set(r.wrongQids || [])
  let got = 0
  let max = 0
  for (const q of reportQs.value) {
    const sc = paperScore(q.type)
    max += sc
    if (needsSelfEval(q)) got += sc * evalRatio(selfEval.value[q.id])
    else if (!wrongSet.has(q.id)) got += sc
  }
  r.score = Math.round(got * 10) / 10
  r.scoreMax = max
  if (persist) {
    db.results.update(r.id, { score: r.score, scoreMax: max, selfEval: { ...selfEval.value } })
      .catch(() => { /* 报告页只读展示，落盘失败不影响当前视图 */ })
  }
}

/* 自评允许改档：考生看完参考答案常会发现点错了。
   改档要同步三处，否则分数、错题本、复习排期会互相打架：
   作答记录（同一题只留一行，改 correct）、错题本（该进就进、该出就出）、记忆卡评分。 */
async function applyEval(q, key) {
  if (selfEval.value[q.id] === key) return
  const prev = selfEval.value[q.id]
  selfEval.value = { ...selfEval.value, [q.id]: key }
  recomputeScore(true)

  const ok = key === 'hit'
  const typed = (report.value?.typed?.[q.id] || '').trim()
  const attemptId = evalAttemptId.get(q.id)
  if (attemptId) {
    await db.attempts.update(attemptId, { correct: ok })
  } else {
    const aid = uid()
    evalAttemptId.set(q.id, aid)
    await db.attempts.put({
      id: aid, questionId: q.id, bankId: q.bankId, mode: 'exam',
      chosen: [typed], correct: ok, at: now(),
    })
  }

  const exist = await db.wrongItems.where('questionId').equals(q.id).first()
  if (ok) {
    // 改判为答对：从错题本撤掉，别让已经掌握了的题继续占位
    if (exist) await db.wrongItems.delete(exist.id)
    await rateCard(q.id, 'good')
  } else {
    if (exist) {
      await db.wrongItems.update(exist.id, {
        wrongCount: (exist.wrongCount || 1) + (prev ? 0 : 1),
        status: 'active', rightStreak: 0, updatedAt: now(),
      })
    } else {
      await db.wrongItems.put({
        id: uid(), questionId: q.id, wrongReasons: [], wrongCount: 1,
        rightStreak: 0, status: 'active', updatedAt: now(),
      })
    }
    await enrollCard(q.id, { lapsed: true })
    await rateCard(q.id, key === 'half' ? 'hard' : 'again')
  }
  scheduleSync(8000)
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
          <div class="bignum" :style="{ color: (report.score / (report.scoreMax || 1)) >= 0.6 ? 'var(--green)' : 'var(--red)' }">
            {{ report.score ?? '—' }}<span style="font-size: 18px; color: var(--ink-3)">/{{ report.scoreMax }}</span>
          </div>
          <div class="muted" style="margin-top: 6px">得分（客观 + 主观自评）</div>
        </div>
        <div class="card" style="text-align: center; padding: 24px">
          <div class="bignum">{{ report.rate }}<span style="font-size: 18px; color: var(--ink-3)">%</span></div>
          <div class="muted" style="margin-top: 6px">客观题正确率 {{ report.right }}/{{ report.total }}</div>
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

      <!-- 主观题自评：系统判不了主观题的表述，只能由考生对照参考答案确认 -->
      <div v-if="subjList.length" class="card" style="margin-bottom: 16px">
        <div class="row between wrap" style="gap: 10px; margin-bottom: 4px">
          <h3 style="font-size: 15px; font-weight: 700">主观题自评</h3>
          <span class="tag" :class="evalDone === subjList.length ? 'green' : 'red'">
            已评 {{ evalDone }} / {{ subjList.length }}
          </span>
        </div>
        <div class="tiny" style="margin-bottom: 12px; color: var(--ink-3); line-height: 1.7">
          名词解释、简答、论述没有唯一表述，无法自动判分。请对照参考答案给自己定档，
          选「答了一半」按 60% 计分，只有「答对了」才算掌握、不进错题本。
        </div>

        <div v-for="(q, i) in subjList" :key="q.id" style="padding: 14px 0" :style="i ? { borderTop: '1px solid var(--line)' } : {}">
          <div class="row between" style="margin-bottom: 6px; gap: 8px">
            <span class="tag">{{ typeLabel(q.type) }} · {{ paperScore(q.type) }} 分</span>
            <span v-if="selfEval[q.id]" class="tag green">
              {{ SELF_EVAL.find((x) => x.key === selfEval[q.id])?.label }}
            </span>
          </div>
          <div style="font-size: 15px; font-weight: 600; white-space: pre-wrap; margin-bottom: 10px">{{ q.stem }}</div>

          <div v-if="report.typed && report.typed[q.id]" style="margin-bottom: 10px">
            <div class="tiny" style="color: var(--ink-3); margin-bottom: 3px">我的作答</div>
            <div class="tiny" style="background: var(--bg); padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; line-height: 1.8">{{ report.typed[q.id] }}</div>
          </div>
          <div>
            <div class="tiny" style="color: var(--ink-3); margin-bottom: 3px">参考答案</div>
            <div class="tiny" style="background: var(--green-weak); padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; line-height: 1.8">{{ (q.answer || []).join('\n') }}</div>
          </div>
          <div v-if="q.analysis" class="tiny" style="margin-top: 8px; color: var(--ink-2); line-height: 1.7">{{ q.analysis }}</div>

          <div class="row wrap" style="gap: 8px; margin-top: 10px">
            <button
              v-for="e in SELF_EVAL"
              :key="e.key"
              class="btn sm"
              :class="selfEval[q.id] === e.key ? '' : 'ghost'"
              :style="selfEval[q.id] === e.key ? { background: e.key === 'hit' ? 'var(--green)' : e.key === 'half' ? 'var(--amber)' : 'var(--red)' } : {}"
              @click="applyEval(q, e.key)"
            >{{ e.label }}</button>
          </div>
        </div>
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
        ><Icon name="clock" :size="16" style="vertical-align: -2px" /> {{ fmt(remain) }}</span>
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
            <span class="tag">{{ typeLabel(cur.type) }}</span>
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
        <textarea
          class="input"
          :rows="needsSelfEval(cur) ? (cur.type === 'term' ? 4 : 6) : 3"
          v-model="exam.typed[cur.id]"
          :placeholder="typeHint(cur.type)"
        ></textarea>
        <div v-if="needsSelfEval(cur)" class="tiny" style="margin-top: 6px; color: var(--ink-3)">
          {{ paperScore(cur.type) }} 分题 · 交卷后对照参考答案自评
        </div>
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
        <div class="ico-wrap"><Icon name="timer" :size="28" /></div>
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

        <div class="field">
          <span class="lab">组卷方式</span>
          <div class="row" style="gap: 8px">
            <button
              class="btn sm"
              :class="paperMode === 'template' ? '' : 'ghost'"
              @click="paperMode = 'template'; timeLimit = 150"
            >按真题结构</button>
            <button
              class="btn sm"
              :class="paperMode === 'custom' ? '' : 'ghost'"
              @click="paperMode = 'custom'"
            >自定义题量</button>
          </div>
          <div v-if="paperMode === 'template'" style="margin-top: 10px">
            <label class="field">
              <span class="lab">卷面结构</span>
              <select class="input" :value="templateId" @change="setTemplate($event.target.value)">
                <option v-for="t in TEMPLATES" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
            </label>
            <div class="tiny" style="margin-top: 8px; color: var(--ink-3); line-height: 1.7">
              {{ tmpl.sections.map((s) => typeLabel(s.type) + ' ' + s.count + '×' + s.score).join(' + ') }}
              = {{ templateTotal(tmpl) }} 分。<br />
              {{ tmpl.note }}；题库里缺哪类题会在开始前提示。
            </div>
          </div>
        </div>

        <div class="grid2">
          <label v-if="paperMode === 'custom'" class="field">
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
          <thead><tr><th>时间</th><th>得分</th><th>客观正确率</th><th>用时</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in reports" :key="r.id">
              <td class="tiny">{{ new Date(r.at).toLocaleString() }}</td>
              <td><b>{{ r.score ?? '—' }}{{ r.scoreMax ? ' / ' + r.scoreMax : '' }}</b></td>
              <td><b :style="{ color: r.rate >= 60 ? 'var(--green)' : 'var(--red)' }">{{ r.rate }}%</b>
                <span class="tiny" style="color: var(--ink-3)">（{{ r.right }}/{{ r.total }}）</span></td>
              <td class="tiny">{{ Math.floor(r.durationSec / 60) }}分</td>
              <td><button class="btn ghost sm" @click="viewReport(r)">查看</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
