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

/* ===== 真题卷结构 =====
   江苏省自考行政管理（本科）专业课的卷面构成，去掉材料题（案例分析）后的版本：
   材料题主观性太强，AI 出不好，也判不了，故不参与组卷。
   单选 30×1 + 多选 5×2 + 名词 5×3 + 简答 5×5 + 论述 2×10 = 100 分 */
export const PAPER_TEMPLATE = {
  id: 'zikao',
  name: '自考标准卷（不含材料题）',
  sections: [
    { type: 'single', count: 30, score: 1 },
    { type: 'multi', count: 5, score: 2 },
    { type: 'term', count: 5, score: 3 },
    { type: 'short', count: 5, score: 5 },
    { type: 'essay', count: 2, score: 10 },
  ],
}

export const TEMPLATE_TOTAL = PAPER_TEMPLATE.sections.reduce((s, x) => s + x.count * x.score, 0)

/* 组卷缺题型时给出人话提示，而不是静默少题 */
export function describeTemplate() {
  return PAPER_TEMPLATE.sections.map((s) => `${typeLabel(s.type)} ${s.count} 题×${s.score} 分`).join('、')
}
