/* 题型注册表：全站唯一来源
   自考卷的题型结构比通用刷题 App 宽：客观题只有单选/多选，
   主观题却有名词解释、简答、论述三种，分值差三倍，判分方式也完全不同。
   这里把「叫什么、几分、能不能自动判」集中定义，视图只查表不写字面量。 */

export const TYPES = {
  single: { label: '单选题', short: '单选', objective: true, score: 1, hint: '' },
  multi: { label: '多选题', short: '多选', objective: true, score: 2, hint: '' },
  judge: { label: '判断题', short: '判断', objective: true, score: 1, hint: '' },
  fill: { label: '填空题', short: '填空', objective: true, score: 1, hint: '输入答案' },
  term: { label: '名词解释', short: '名词', objective: false, score: 3, hint: '写出定义，几句话即可' },
  short: { label: '简答题', short: '简答', objective: false, score: 5, hint: '按要点作答，不必展开' },
  essay: { label: '论述题', short: '论述', objective: false, score: 10, hint: '先列要点，再展开论证' },
  // 材料题不参与 AI 出题与组卷（主观性太强），但导入真题卷时要能正常作答
  material: { label: '材料题', short: '材料', objective: false, score: 10, hint: '结合材料，分点作答' },
}

/* 主观题：系统不判对错，由考生对照参考答案自评 */
export const SUBJECTIVE = ['term', 'short', 'essay', 'material']

export const isObjective = (type) => TYPES[type]?.objective !== false
export const typeLabel = (type) => TYPES[type]?.label || type
export const typeScore = (type) => TYPES[type]?.score ?? 1
export const typeHint = (type) => TYPES[type]?.hint || ''

/* 自评三档 → SM-2 评分。主观题答成什么样只有考生自己知道，
   强行用字符串比对只会把每道主观题都塞进错题本。 */
export const SELF_EVAL = [
  { key: 'hit', label: '答对了', rating: 'good', correct: true, ratio: 1 },
  { key: 'half', label: '答了一半', rating: 'hard', correct: false, ratio: 0.6 },
  { key: 'miss', label: '没答出来', rating: 'again', correct: false, ratio: 0 },
]

export const evalRatio = (key) => SELF_EVAL.find((x) => x.key === key)?.ratio ?? 0
export const evalRating = (key) => SELF_EVAL.find((x) => x.key === key)?.rating ?? 'again'

/* ===== 真题卷结构：一科一套，不能混用 =====
   依据是各科官方评分参考原文，不是「大概按百分制凑」：
   - 00261 行政法学（2020/8、2021/4 两套核对过）：单选 30、多选 5、名词 5、
     简答 3、论述 1，另有案例分析 2×10。
   - 01680 城市管理学（精讲一刊载的题型表）：单选 20、多选 10、简答 5、
     论述 2，另有案例题 1×15。**这一科没有名词解释**。
   - 03450 公共部门人力资源管理（2024/10 全国统考试卷原文）：单选 10、多选 5、
     名词 5、简答 5、论述 2。**各题型分值与通用值不同**（名词 4 分、简答 6 分、
     论述 15 分），所以试卷必须把分值随卷存库，否则交卷会把 100 分算成 80 分。
   材料题／案例题主观性太强，AI 出不好也判不了，统一不进组卷，
   所以各模板的组卷满分不等于 100，界面必须显示实际满分而不是想当然的 100。 */
export const TEMPLATES = [
  {
    id: '00261',
    name: '自考行政法学卷（00261）',
    subjects: ['行政法学', '00261'],
    note: '材料题（案例分析 2×10 = 20 分）不参与组卷，组卷满分 80',
    sections: [
      { type: 'single', count: 30, score: 1 },
      { type: 'multi', count: 5, score: 2 },
      { type: 'term', count: 5, score: 3 },
      { type: 'short', count: 3, score: 5 },
      { type: 'essay', count: 1, score: 10 },
    ],
  },
  {
    id: '01680',
    name: '城市管理学报（01680）',
    subjects: ['城市管理学', '01680'],
    note: '本科没有名词解释；案例题（1×15 = 15 分）不参与组卷，组卷满分 85',
    sections: [
      { type: 'single', count: 20, score: 1 },
      { type: 'multi', count: 10, score: 2 },
      { type: 'short', count: 5, score: 5 },
      { type: 'essay', count: 2, score: 10 },
    ],
  },
  {
    id: '03450',
    name: '自考公共部门人力资源管理卷（03450）',
    subjects: ['公共部门人力资源管理', '03450'],
    note: '全国统考卷面 27 题、100 分；名词解释 4 分、简答 6 分、论述 15 分',
    sections: [
      { type: 'single', count: 10, score: 1 },
      { type: 'multi', count: 5, score: 2 },
      { type: 'term', count: 5, score: 4 },
      { type: 'short', count: 5, score: 6 },
      { type: 'essay', count: 2, score: 15 },
    ],
  },
]

export const DEFAULT_TEMPLATE_ID = TEMPLATES[0].id

export function templateById(id) {
  return TEMPLATES.find((t) => t.id === id) || TEMPLATES[0]
}

/* 组卷满分（不含材料／案例题） */
export function templateTotal(t) {
  return (t || TEMPLATES[0]).sections.reduce((s, x) => s + x.count * x.score, 0)
}

/* 按科目名/课程代码猜模板：题库归属科目或题库名里带「城市管理学」「01680」都算命中。
   猜不到返回 null，由界面保留上一次的选择，不要瞎套一套结构给考生。 */
export function templateForSubject(...hints) {
  const text = hints
    .filter(Boolean)
    .map((s) => String(s))
    .join(' ')
  if (!text.trim()) return null
  return (
    TEMPLATES.find((t) => t.subjects.some((k) => text.includes(k))) || null
  )
}

/* 组卷缺题型时给出人话提示，而不是静默少题 */
export function describeTemplate(t = TEMPLATES[0]) {
  return t.sections.map((s) => `${typeLabel(s.type)} ${s.count} 题×${s.score} 分`).join('、')
}

/* 兼容旧引用：不指定模板时按默认（行政法学）算 */
export const PAPER_TEMPLATE = TEMPLATES[0]
export const TEMPLATE_TOTAL = templateTotal(PAPER_TEMPLATE)
