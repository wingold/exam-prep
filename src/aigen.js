/* AI 出题共享模块：非流式对话 + JSON 题目生成（弱项出卷 / PDF 讲义出题共用） */

import { getAIConfig, aiReady } from './ai'

/* 非流式请求，带超时 */
export async function chatOnce(messages, { timeoutMs = 180000, temperature = 0.4 } = {}) {
  const cfg = getAIConfig()
  if (!aiReady()) throw new Error('未配置模型接口，请先到设置页填写 Base URL / API Key / 模型名')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, temperature }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`模型接口返回 ${res.status}：${t.slice(0, 180)}`)
    }
    const j = await res.json()
    return j.choices?.[0]?.message?.content || ''
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('模型响应超时，请稍后重试或换更快的模型')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/* 从 AI 文本中宽容提取 JSON 数组：剥掉代码围栏，取首个 [ 到末个 ] */
export function extractJsonArray(text) {
  let t = String(text || '')
  t = t.replace(/```json/gi, '').replace(/```/g, '')
  const s = t.indexOf('[')
  const e = t.lastIndexOf(']')
  if (s < 0 || e <= s) throw new Error('AI 输出中未找到 JSON 题目数组')
  return JSON.parse(t.slice(s, e + 1))
}

/* ===== 出题口径：对齐江苏省自考行政管理（本科）专业课的卷面结构 =====
   真实卷面的主观题占比超过一半，分值差异也大（名词 3 分、简答 5 分、论述 10 分）。
   通用刷题 App 的「单选+判断」出题方式在这里等于练不到重点，所以出题必须按题型配额。 */

export const TYPE_SPEC = [
  '题型只能是以下五种之一，禁止出判断题、填空题、材料题：',
  '- single 单选题：4 个选项，answer 为 1 个字母，如 ["B"]',
  '- multi 多选题：4 或 5 个选项，answer 为 2 个以上字母，如 ["A","C","D"]（错选、多选、少选均不得分，所以选项之间必须有明确的取舍）',
  '- term 名词解释：options 留空数组，answer 为 ["一段完整的定义，2-3 句话，含主体、对象、性质"]',
  '- short 简答题：options 留空数组，answer 为 ["分点作答，写成（1）…（2）…（3）…，只给要点不展开"]',
  '- essay 论述题：options 留空数组，answer 为 ["先给 3-5 个要点，再说明每个要点要展开什么，能体现论证层次"]',
]

/* 按总题量分配各题型配额：客观题占一半，主观题占一半，
   与自考卷「单选 30 题、其余大题 12 题」的比例感保持一致 */
export function typeQuota(total) {
  const n = Math.max(4, Number(total) || 8)
  const single = Math.max(2, Math.round(n * 0.5))
  const multi = Math.max(1, Math.round(n * 0.15))
  const term = Math.max(1, Math.round(n * 0.15))
  const short = Math.max(1, Math.round(n * 0.12))
  const essay = Math.max(1, n - single - multi - term - short)
  return { single, multi, term, short, essay }
}

function quotaLine(total) {
  const q = typeQuota(total)
  return `各题型数量：单选 ${q.single} 题、多选 ${q.multi} 题、名词解释 ${q.term} 题、简答 ${q.short} 题、论述 ${q.essay} 题。`
}

/* 讲义内容 → 题目的用户提示词 */
export function genQuestionsPrompt(content, { chapter = '', count = 8 } = {}) {
  return [
    `把下面的讲义内容改编成 ${count} 道自考练习题，输出一个 JSON 数组，不要任何解释文字。`,
    '要求：',
    '1. 每题格式：{"type":"single|multi|term|short|essay","chapter":"章节名","stem":"题干","options":[],"answer":[""],"analysis":"解析：说明考点依据","difficulty":""}',
    ...TYPE_SPEC,
    `2. ${quotaLine(count)}`,
    '3. 名词解释的 stem 只写被解释的术语本身，不要把定义写进题干',
    '4. 简答题用「简述……」「说明……的构成要件」这类问法；论述题用「试述……」「论述……的意义」这类问法',
    '5. 高频考点、常考易错点标 "difficulty":"重点"，普通题该字段留空字符串',
    '6. 只输出 JSON 数组本身，不要 markdown 围栏',
    '',
    chapter ? `章节标题：${chapter}` : '',
    '讲义内容：',
    content.slice(0, 6000),
  ]
    .filter(Boolean)
    .join('\n')
}

/* 单段内容生成题目（返回原始数组，未归一化） */
export async function genQuestionsRaw(content, opts = {}) {
  const text = await chatOnce([
    { role: 'system', content: '你是严谨的考证出题专家，永远只输出合法 JSON，绝不输出解释文字。' },
    { role: 'user', content: genQuestionsPrompt(content, opts) },
  ])
  const arr = extractJsonArray(text)
  return arr.filter((q) => q && typeof q.stem === 'string' && q.stem.trim() && Array.isArray(q.answer))
}

/* 讲义内容 → 知识点卡片的用户提示词 */
export function genCardsPrompt(content, { chapter = '', count = 8 } = {}) {
  return [
    `把下面的讲义内容提取成 ${count} 张可背诵的知识点卡片，输出一个 JSON 数组，不要任何解释文字。`,
    '要求：',
    '1. 每张格式：{"front":"要回忆的钩子（概念名/考点/简短问题）","back":"答案要点，1-3 句，适合直接背诵","chapter":"章节名","difficulty":""}',
    '2. front 要短、可触发回忆；back 是背诵本体，精炼不啰嗦',
    '3. 高频考点、必背条目标 "difficulty":"重点"，其余留空字符串',
    '4. 只输出 JSON 数组本身，不要markdown围栏',
    '',
    chapter ? `章节标题：${chapter}` : '',
    '讲义内容：',
    content.slice(0, 6000),
  ]
    .filter(Boolean)
    .join('\n')
}

/* 单段内容提取知识卡片（原始数组） */
export async function genCardsRaw(content, opts = {}) {
  const text = await chatOnce([
    { role: 'system', content: '你是考证背诵卡片整理专家，永远只输出合法 JSON。' },
    { role: 'user', content: genCardsPrompt(content, opts) },
  ])
  const arr = extractJsonArray(text)
  return arr.filter((c) => c && typeof c.front === 'string' && c.front.trim() && typeof c.back === 'string' && c.back.trim())
}

/* 弱项出卷：薄弱章节 + 近期错题 → 题目数组 */
export async function genWeakQuestions({ weakChapters = [], wrongStems = [], count = 8 } = {}) {
  const lines = [
    '一位考生最近在准备江苏省自考行政管理（本科）的专业课考试，薄弱点如下：',
    weakChapters.length ? `薄弱章节（正确率从低到高）：${weakChapters.map((c) => `${c.chapter}（${c.rate}%）`).join('、')}` : '',
    wrongStems.length ? `近期错题涉及的知识点：\n${wrongStems.map((s, i) => `${i + 1}. ${s.slice(0, 80)}`).join('\n')}` : '',
    '',
    `请针对这些薄弱点出 ${count} 道练习题，输出一个 JSON 数组，不要任何解释文字。`,
    '要求：',
    '1. 每题格式：{"type":"single|multi|term|short|essay","chapter":"对应薄弱章节名","stem":"题干","options":[],"answer":[""],"analysis":"解析：说明考点","difficulty":"重点"}',
    ...TYPE_SPEC,
    `2. ${quotaLine(count)}`,
    '3. 名词解释的 stem 只写被解释的术语本身',
    '4. difficulty 全部标 "重点"',
    '5. 只输出 JSON 数组本身',
  ].filter(Boolean)
  const text = await chatOnce([
    { role: 'system', content: '你是严谨的自考命题专家，熟悉江苏省行政管理专业本科段的题型结构与评分标准，永远只输出合法 JSON。' },
    { role: 'user', content: lines.join('\n') },
  ])
  const arr = extractJsonArray(text)
  return arr.filter((q) => q && typeof q.stem === 'string' && q.stem.trim() && Array.isArray(q.answer))
}
