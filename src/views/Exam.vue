<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import db, { uid, now, purge, plain } from '../db'
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
/* 答案公布时机：
   after —— 交卷后统一公布（默认，模拟真实考试，做题时不剧透）
   each  —— 每题作答后立刻公布，客观题当场判对错、主观题对照参考答案自评，再进下一题。
            适合「做完一题马上巩固/纠正」，代价是失去模考的临场感。 */
const ANSWER_MODE_KEY = 'exam_answer_mode'
const answerMode = ref(localStorage.getItem(ANSWER_MODE_KEY) || 'after')
function setAnswerMode(m) {
  answerMode.value = m
  localStorage.setItem(ANSWER_MODE_KEY, m)
}
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
      // 逐题公布模式下要把「已公布到哪题」和「主观题自评」一起存，
      // 否则切走再回来会重复公布、自评也白评了
      answerMode: answerMode.value,
      revealed: e.revealed || {},
      selfEval: e.selfEval || {},
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
    // 逐题公布：记已公布的题与主观题自评档位，交卷时一并落库
    revealed: {},
    selfEval: {},
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
    revealed: raw.revealed || {},
    selfEval: raw.selfEval || {},
  }
  if (raw.answerMode === 'each' || raw.answerMode === 'after') setAnswerMode(raw.answerMode)
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

/* ===== 逐题公布答案（answerMode = 'each'） ===== */
function revealedOf(q) {
  return !!(q && exam.value && exam.value.revealed?.[q.id])
}

/* 公布当前题的答案。公布后本题锁定：不能再看答案改答案，否则分数没意义。 */
function revealCur() {
  const q = cur.value
  if (!q || !exam.value) return
  exam.value.revealed = { ...(exam.value.revealed || {}), [q.id]: true }
}

/* 「下一题」的两种含义：逐题模式下第一次点只是公布答案，第二次才真正翻页 */
function nextStep() {
  const e = exam.value
  if (!e) return
  if (answerMode.value === 'each' && !revealedOf(cur.value)) {
    revealCur()
    return
  }
  if (e.idx + 1 < e.questions.length) e.idx++
}

/* 当前题公布后的判定结果：客观题给对错，主观题给参考答案等考生自评 */
const curReveal = computed(() => {
  const q = cur.value
  const e = exam.value
  if (!q || !e || !revealedOf(q)) return null
  const auto = !needsSelfEval(q)
  const chosen = q.type === 'fill'
    ? [(e.typed[q.id] || '').trim()]
    : (e.answers[q.id] || [])
  return {
    auto,
    chosen,
    correct: auto ? isCorrect(q, chosen) : null,
    answer: q.answer || [],
    evalKey: (e.selfEval || {})[q.id] || '',
  }
})

/* 答题时给主观题自评：结果先记在本次考试里，交卷时统一落库，
   这样「作答 → 看答案 → 自评 → 下一题」能连贯做完，不必回报告页再点一遍。 */
function evalInExam(q, key) {
  if (!exam.value) return
  exam.value.selfEval = { ...(exam.value.selfEval || {}), [q.id]: key }
}

function toggle(letter) {
  const q = cur.value
  // 已公布答案的题锁定，避免「看了答案再改」
  if (revealedOf(q)) return
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
  /* 逐题模式下考生已在答题时自评过主观题，这里要一并落库，
     否则交卷后报告页显示「未自评」、分数也只算客观题。 */
  const evals = { ...(e.selfEval || {}) }
  for (const q of e.questions) {
    if (!needsSelfEval(q)) continue
    const key = evals[q.id]
    if (key) await writeEval(q, key, (e.typed[q.id] || '').trim())
  }

  const result = {
    id: uid(),
    paperId: e.paperId,
    bankId: e.questions[0]?.bankId,
    total,
    right,
    wrong: total - right,
    rate: total ? Math.round((right / total) * 100) : 0,
    subjectiveTotal: subjTotal,
    selfEval: evals,
    // 客观题的选项要留着，报告页才能逐题显示「我选了什么」。
    // 旧版本报告没有这个字段，viewReport 会回退到 attempts 里找。
    answers: { ...e.answers },
    // 主观题的作答原文留着，报告页自评时要跟参考答案对着看
    typed: { ...e.typed },
    durationSec: Math.min(e.timeLimitMin * 60, Math.max(0, Math.round((Date.now() - e.startedAt) / 1000))),
    perChapter,
    wrongQids,
    at: now(),
  }
  /* result.answers 里的数组来自 exam.value（Vue 响应式 Proxy），
     IndexedDB 的结构化克隆拒绝 Proxy，直接 put 会抛 DataCloneError，
     表现就是「点了交卷没反应、停在答题页」。入库前统一转成纯对象。 */
  await db.results.put(plain(result))
  reports.value = await db.results.orderBy('at').reverse().limit(20).toArray()
  /* 报告页必须绑定「历史成绩列表里的同一条记录」。
     早先这里传的是上面新建的 result 对象，它和 reports 里那条是两个引用：
     报告页自评时改的是 result.score，列表里那条不动 ——
     表现就是「自评完点返回，历史成绩显示 —，再点进去还是旧分数，
     非得重新评一遍才更新」，看起来像分数没被记录（其实 DB 早就写进去了）。 */
  const savedResult = reports.value.find((x) => x.id === result.id) || result
  // 交卷后延迟同步：一次考试几十条作答记录，别等下一次启动才上传
  scheduleSync(10000)
  clearDraft()
  viewReport(savedResult)
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
const reportAttempts = ref({}) // qid → 本次考试的 attempt，用于回填客观题作答
const detailFilter = ref('all') // all | wrong | subj

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
  detailFilter.value = 'all'

  /* 逐题解析要显示「我选了什么」「我写了什么」，而作答分散在两处：
     客观题在 results.answers（新报告才有），主观题原文在 results.typed，
     更早的报告连 answers 都没有，只能回 attempts 里找本次考试写入的那条。
     时间窗口 5 分钟：交卷与自评落库都紧接在 r.at 之后完成，
     拉开太大就会误取到「同一题在另一次考试里」的记录。 */
  reportAttempts.value = {}
  if (reportQs.value.length) {
    const ids = reportQs.value.map((q) => q.id)
    const ats = await db.attempts.where('questionId').anyOf(ids).toArray()
    const byQ = {}
    for (const a of ats) {
      if (a.mode !== 'exam') continue
      if (Math.abs((a.at || 0) - (r.at || 0)) > 300000) continue
      if (!byQ[a.questionId] || (a.at || 0) > (byQ[a.questionId].at || 0)) byQ[a.questionId] = a
    }
    reportAttempts.value = byQ
    // 历史报告改档时要更新原来那条作答记录，不能又新建一行
    for (const q of reportQs.value) {
      const a = byQ[q.id]
      if (a && needsSelfEval(q)) evalAttemptId.set(q.id, a.id)
    }
  }

  showReport.value = true
  recomputeScore()
}

/* 报告里的主观题：交卷时判不了分，需要考生对照参考答案自评 */
const subjList = computed(() => reportQs.value.filter((q) => needsSelfEval(q)))
const evalDone = computed(() => subjList.value.filter((q) => selfEval.value[q.id]).length)

/* ---- 逐题解析 ----
   原来报告页只告诉考生「错了几道、已加入错题本」，答对的题连题干和答案都看不到，
   考完想马上巩固错的、回看对的都做不到。这里把所有题目按题号摊开：
   题干、选项、我选了什么、正确答案、解析，主观题就在这一行里自评。 */

/* 我在这道题上的作答：优先取本次报告存的，其次回退到 attempts */
function chosenFor(q) {
  const saved = report.value?.answers?.[q.id]
  if (Array.isArray(saved) && saved.length) return saved
  const a = reportAttempts.value[q.id]
  if (a && Array.isArray(a.chosen) && a.chosen.length) return a.chosen
  if (needsSelfEval(q)) return []
  if (q.type === 'fill') {
    const t = (report.value?.typed?.[q.id] || '').trim()
    return t ? [t] : []
  }
  return []
}

const detailRows = computed(() => {
  const r = report.value
  if (!r) return []
  const wrongSet = new Set(r.wrongQids || [])
  const rows = reportQs.value.map((q, i) => {
    const auto = !needsSelfEval(q)
    const evalKey = selfEval.value[q.id] || ''
    const judged = auto || !!evalKey
    return {
      q,
      no: i + 1,
      auto,
      chosen: chosenFor(q),
      evalKey,
      judged,
      // 客观题看对错集合；主观题只有自评「答对了」才算掌握
      ok: auto ? !wrongSet.has(q.id) : evalKey === 'hit',
      score: paperScore(q.type),
      typed: (r.typed?.[q.id] || '').trim(),
    }
  })
  if (detailFilter.value === 'wrong') return rows.filter((x) => x.judged && !x.ok)
  if (detailFilter.value === 'subj') return rows.filter((x) => !x.auto)
  return rows
})

const detailCounts = computed(() => {
  const r = report.value
  const rows = reportQs.value.map((q) => {
    const auto = !needsSelfEval(q)
    const evalKey = selfEval.value[q.id] || ''
    const judged = auto || !!evalKey
    const ok = auto ? !new Set(r?.wrongQids || []).has(q.id) : evalKey === 'hit'
    return { auto, judged, ok }
  })
  return {
    all: rows.length,
    wrong: rows.filter((x) => x.judged && !x.ok).length,
    subj: rows.filter((x) => !x.auto).length,
  }
})

/* 某道客观题的选项该显示成什么状态：正确答案标绿、选错的标红 */
function optState(q, letter) {
  const isRight = (q.answer || []).includes(letter)
  const mine = chosenFor(q).includes(letter)
  return { isRight, mine, wrongPick: mine && !isRight }
}

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
  // 内存里的这条记录也要带上自评：从历史列表重新点进来时，
  // viewReport 是从 r.selfEval 恢复档位的，不写回就会退回「未自评」
  r.selfEval = { ...selfEval.value }
  if (persist) {
    /* 返回 Promise 让调用方 await：自评完马上点返回或刷新时，
       写入可能还没完成，会读到旧分数。失败也不静默。 */
    return db.results
      .update(r.id, plain({ score: r.score, scoreMax: max, selfEval: { ...selfEval.value } }))
      .catch((e) => console.warn('[exam] 保存自评分数失败', e))
  }
}

/* 把一次主观题自评落到三个地方，缺一个就会互相打架：
   作答记录（同一题只留一行，改档时 update）、错题本（该进就进、该出就出）、记忆卡评分。
   报告页改档与「交卷时批量落库」共用这一段，避免两套逻辑走偏。 */
async function writeEval(q, key, typed) {
  const ok = key === 'hit'
  const attemptId = evalAttemptId.get(q.id)
  // 没有 attemptId = 这道题第一次评；有 = 改档，错题次数不再累加
  const firstTime = !attemptId
  if (attemptId) {
    await db.attempts.update(attemptId, { correct: ok })
  } else {
    const aid = uid()
    evalAttemptId.set(q.id, aid)
    await db.attempts.put({
      id: aid, questionId: q.id, bankId: q.bankId, mode: 'exam',
      chosen: [typed || ''], correct: ok, at: now(),
    })
  }

  const exist = await db.wrongItems.where('questionId').equals(q.id).first()
  if (ok) {
    // 判为答对：从错题本撤掉，别让已经掌握了的题继续占位
    if (exist) await purge('wrongItems', [exist.id])
    await rateCard(q.id, 'good')
  } else {
    if (exist) {
      await db.wrongItems.update(exist.id, {
        wrongCount: (exist.wrongCount || 1) + (firstTime ? 1 : 0),
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
}

/* 自评允许改档：考生看完参考答案常会发现点错了 */
async function applyEval(q, key) {
  if (selfEval.value[q.id] === key) return
  selfEval.value = { ...selfEval.value, [q.id]: key }
  await recomputeScore(true)
  await writeEval(q, key, (report.value?.typed?.[q.id] || '').trim())
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

      <div
        v-if="subjList.length && evalDone < subjList.length"
        class="card"
        style="margin-bottom: 16px; border-color: var(--amber); background: var(--amber-weak)"
      >
        <div style="font-size: 14px; font-weight: 700; color: var(--amber)">
          还有 {{ subjList.length - evalDone }} 道主观题没自评
        </div>
        <div class="tiny" style="margin-top: 5px; line-height: 1.7">
          当前 {{ report.score }} 分只含客观题与已自评的主观题。名词解释、简答、论述没有唯一表述，
          系统判不了，往下翻到「逐题答案与解析」对照参考答案给自己定档，分数会实时更新。
        </div>
      </div>

      <div v-if="avgCompare" class="card" style="margin-bottom: 16px">
        <span class="muted">与历史平均对比：平均 {{ avgCompare.avg }}%，本次</span>
        <b :style="{ color: avgCompare.delta >= 0 ? 'var(--green)' : 'var(--red)', marginLeft: 6 }">
          {{ avgCompare.delta >= 0 ? '+' : '' }}{{ avgCompare.delta }}%
        </b>
      </div>

      <!-- 逐题答案与解析：交卷后把所有题目摊开，答对的也能回看巩固 -->
      <div class="card" style="margin-bottom: 16px">
        <div class="row between wrap" style="gap: 10px; margin-bottom: 4px">
          <h3 style="font-size: 15px; font-weight: 700">逐题答案与解析</h3>
          <span class="tiny" style="color: var(--ink-3)">
            客观 {{ report.right }}/{{ report.total }} 对<span v-if="subjList.length"> · 主观已评 {{ evalDone }}/{{ subjList.length }}</span>
          </span>
        </div>
        <div class="tiny" style="margin-bottom: 12px; color: var(--ink-3); line-height: 1.7">
          答对的也建议扫一眼解析，别让「蒙对」混过去；主观题就在题目下方自评，评完分数实时更新。
        </div>

        <div class="row wrap" style="gap: 8px">
          <button class="btn sm" :class="detailFilter === 'all' ? '' : 'ghost'" @click="detailFilter = 'all'">
            全部 {{ detailCounts.all }}
          </button>
          <button class="btn sm" :class="detailFilter === 'wrong' ? '' : 'ghost'" @click="detailFilter = 'wrong'">
            错题 {{ detailCounts.wrong }}
          </button>
          <button
            v-if="detailCounts.subj"
            class="btn sm"
            :class="detailFilter === 'subj' ? '' : 'ghost'"
            @click="detailFilter = 'subj'"
          >主观题 {{ detailCounts.subj }}</button>
        </div>

        <div v-if="!detailRows.length" class="tiny" style="padding: 14px 0; color: var(--ink-3)">
          {{ detailFilter === 'wrong' ? '这次没有错题 ✓' : '没有符合条件的题目' }}
        </div>

        <div
          v-for="row in detailRows"
          :key="row.q.id"
          style="padding: 16px 0"
          :style="{ borderTop: '1px solid var(--line)' }"
        >
          <div class="row between wrap" style="margin-bottom: 8px; gap: 8px">
            <div class="row" style="gap: 8px">
              <b style="font-size: 14px">{{ row.no }}.</b>
              <span class="tag">{{ typeLabel(row.q.type) }} · {{ row.score }} 分</span>
              <span class="tiny" v-if="row.q.chapter" style="color: var(--ink-3)">{{ row.q.chapter }}</span>
            </div>
            <span
              class="tag"
              :class="row.judged ? (row.ok ? 'green' : 'red') : 'amber'"
            >
              {{ row.auto
                ? (row.ok ? '答对' : '答错')
                : (row.judged ? '自评：' + (SELF_EVAL.find((e) => e.key === row.evalKey)?.label || '') : '待自评') }}
            </span>
          </div>

          <div style="font-size: 15px; font-weight: 600; white-space: pre-wrap; margin-bottom: 10px">{{ row.q.stem }}</div>

          <!-- 客观题选项：正确答案标绿，选错项标红 -->
          <div
            v-if="['single', 'multi', 'judge'].includes(row.q.type)"
            style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px"
          >
            <div
              v-for="(opt, i) in (row.q.type === 'judge' && !row.q.options.length ? ['对', '错'] : row.q.options)"
              :key="i"
              class="tiny"
              style="padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); line-height: 1.7"
              :style="optState(row.q, row.q.type === 'judge' ? opt : 'ABCDEF'[i]).isRight
                ? { borderColor: 'var(--green)', background: 'var(--green-weak)' }
                : optState(row.q, row.q.type === 'judge' ? opt : 'ABCDEF'[i]).wrongPick
                  ? { borderColor: 'var(--red)', background: 'var(--red-weak)' }
                  : {}"
            >
              <b v-if="row.q.type !== 'judge'">{{ 'ABCDEF'[i] }}.</b> {{ opt }}
              <b
                v-if="optState(row.q, row.q.type === 'judge' ? opt : 'ABCDEF'[i]).isRight"
                style="color: var(--green)"
              >　✓ 正确答案</b>
              <b
                v-else-if="optState(row.q, row.q.type === 'judge' ? opt : 'ABCDEF'[i]).wrongPick"
                style="color: var(--red)"
              >　✗ 你选的</b>
            </div>
          </div>

          <div v-if="row.auto" class="tiny" style="margin-bottom: 8px; line-height: 1.8">
            <span style="color: var(--ink-3)">我的作答：</span>
            <b v-if="row.chosen.length">{{ row.chosen.join('、') }}</b>
            <b v-else style="color: var(--amber)">未作答</b>
            <span style="color: var(--ink-3); margin-left: 14px">正确答案：</span>
            <b style="color: var(--green)">{{ (row.q.answer || []).join('、') }}</b>
          </div>

          <template v-else>
            <div v-if="row.typed" style="margin-bottom: 10px">
              <div class="tiny" style="color: var(--ink-3); margin-bottom: 3px">我的作答</div>
              <div class="tiny" style="background: var(--bg); padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; line-height: 1.8">{{ row.typed }}</div>
            </div>
            <div v-else class="tiny" style="margin-bottom: 10px; color: var(--amber)">未作答</div>
            <div>
              <div class="tiny" style="color: var(--ink-3); margin-bottom: 3px">参考答案</div>
              <div class="tiny" style="background: var(--green-weak); padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; line-height: 1.8">{{ (row.q.answer || []).join('\n') }}</div>
            </div>
            <div class="row wrap" style="gap: 8px; margin-top: 10px">
              <button
                v-for="e in SELF_EVAL"
                :key="e.key"
                class="btn sm"
                :class="selfEval[row.q.id] === e.key ? '' : 'ghost'"
                :style="selfEval[row.q.id] === e.key ? { background: e.key === 'hit' ? 'var(--green)' : e.key === 'half' ? 'var(--amber)' : 'var(--red)' } : {}"
                @click="applyEval(row.q, e.key)"
              >{{ e.label }}（{{ Math.round(e.ratio * 100) }}%）</button>
            </div>
          </template>

          <div v-if="row.q.analysis" class="tiny" style="margin-top: 9px; color: var(--ink-2); line-height: 1.8">
            <b>解析：</b>{{ row.q.analysis }}
          </div>
        </div>

        <div v-if="report.wrongQids?.length" class="row wrap" style="gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line)">
          <span class="tiny" style="color: var(--ink-3); line-height: 2">
            本次 {{ report.wrongQids.length }} 道错题已加入错题本
          </span>
          <router-link to="/wrong"><button class="btn ghost sm">去错题本复习</button></router-link>
        </div>
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
          :disabled="revealedOf(cur)"
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
          :disabled="revealedOf(cur)"
        ></textarea>
        <div v-if="needsSelfEval(cur)" class="tiny" style="margin-top: 6px; color: var(--ink-3)">
          {{ paperScore(cur.type) }} 分题 ·
          {{ answerMode === 'each' ? '点「看答案」对照参考答案自评，再进下一题' : '交卷后对照参考答案自评' }}
        </div>
      </div>

      <!-- 逐题公布：客观题当场判对错，主观题给参考答案由考生自评 -->
      <div
        v-if="curReveal"
        class="card"
        style="margin-bottom: 14px"
        :style="{ borderColor: curReveal.auto ? (curReveal.correct ? 'var(--green)' : 'var(--red)') : 'var(--accent)' }"
      >
        <div class="row between wrap" style="gap: 8px; margin-bottom: 9px">
          <b
            style="font-size: 15px"
            :style="{ color: curReveal.auto ? (curReveal.correct ? 'var(--green)' : 'var(--red)') : 'var(--accent)' }"
          >
            {{ curReveal.auto ? (curReveal.correct ? '✓ 答对了' : '✗ 答错了') : '对照参考答案给自己定档' }}
          </b>
          <span class="tag">{{ paperScore(cur.type) }} 分</span>
        </div>

        <div v-if="curReveal.auto" class="tiny" style="line-height: 1.9">
          <span style="color: var(--ink-3)">我的作答：</span>
          <b v-if="curReveal.chosen.length">{{ curReveal.chosen.join('、') }}</b>
          <b v-else style="color: var(--amber)">未作答</b>
          <span style="color: var(--ink-3); margin-left: 14px">正确答案：</span>
          <b style="color: var(--green)">{{ curReveal.answer.join('、') }}</b>
        </div>

        <div v-else>
          <div class="tiny" style="color: var(--ink-3); margin-bottom: 3px">参考答案</div>
          <div
            class="tiny"
            style="background: var(--green-weak); padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; line-height: 1.8"
          >{{ curReveal.answer.join('\n') }}</div>
          <div class="row wrap" style="gap: 8px; margin-top: 10px">
            <button
              v-for="e in SELF_EVAL"
              :key="e.key"
              class="btn sm"
              :class="curReveal.evalKey === e.key ? '' : 'ghost'"
              :style="curReveal.evalKey === e.key ? { background: e.key === 'hit' ? 'var(--green)' : e.key === 'half' ? 'var(--amber)' : 'var(--red)' } : {}"
              @click="evalInExam(cur, e.key)"
            >{{ e.label }}（{{ Math.round(e.ratio * 100) }}%）</button>
          </div>
          <div class="tiny" style="margin-top: 8px; color: var(--ink-3); line-height: 1.7">
            自评会计入分数：答对了不进错题本，答了一半按 60% 计分，没答出来进错题本并安排复习。
          </div>
        </div>

        <div v-if="cur.analysis" class="tiny" style="margin-top: 9px; color: var(--ink-2); line-height: 1.8">
          <b>解析：</b>{{ cur.analysis }}
        </div>
      </div>

      <div class="row between">
        <button class="btn ghost" :disabled="exam.idx === 0" @click="exam.idx--">上一题</button>
        <div class="row" style="gap: 8px">
          <button
            v-if="answerMode === 'each' && !revealedOf(cur)"
            class="btn"
            @click="nextStep"
          >看答案</button>
          <button
            v-else-if="exam.idx + 1 < exam.questions.length"
            class="btn"
            @click="nextStep"
          >下一题</button>
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

        <div class="field">
          <span class="lab">答案公布</span>
          <div class="row" style="gap: 8px">
            <button class="btn sm" :class="answerMode === 'after' ? '' : 'ghost'" @click="setAnswerMode('after')">
              交卷后统一公布
            </button>
            <button class="btn sm" :class="answerMode === 'each' ? '' : 'ghost'" @click="setAnswerMode('each')">
              每题作答后公布
            </button>
          </div>
          <div class="tiny" style="margin-top: 8px; color: var(--ink-3); line-height: 1.7">
            {{ answerMode === 'each'
              ? '做完一题点「看答案」就能对答案：客观题当场判对错，主观题对照参考答案自评后再进下一题。适合边练边巩固，代价是失去模考的临场感。'
              : '做题时不剧透，交卷后统一公布全部题目与解析。适合模考。' }}
          </div>
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
