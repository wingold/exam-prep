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

/* 讲义内容 → 题目的用户提示词 */
export function genQuestionsPrompt(content, { chapter = '', count = 8 } = {}) {
  return [
    `把下面的讲义内容改编成 ${count} 道考证练习题，输出一个 JSON 数组，不要任何解释文字。`,
    '要求：',
    '1. 每题格式：{"type":"single|multi|judge|fill","chapter":"章节名","stem":"题干","options":["A选项","B选项","C选项","D选项"],"answer":["A"],"analysis":"解析：说明考点依据","difficulty":""}',
    '2. 单选/多选给4个options，answer为字母数组；判断题options留空、answer为["对"]或["错"]；填空题options留空、answer为答案文本数组',
    '3. 高频考点、常考易错点标 "difficulty":"重点"，普通题该字段留空字符串',
    '4. 只输出 JSON 数组本身，不要markdown围栏',
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

/* 弱项出卷：薄弱章节 + 近期错题 → 题目数组 */
export async function genWeakQuestions({ weakChapters = [], wrongStems = [], count = 8 } = {}) {
  const lines = [
    '一位考生最近的薄弱点如下：',
    weakChapters.length ? `薄弱章节（正确率从低到高）：${weakChapters.map((c) => `${c.chapter}（${c.rate}%）`).join('、')}` : '',
    wrongStems.length ? `近期错题涉及的知识点：\n${wrongStems.map((s, i) => `${i + 1}. ${s.slice(0, 80)}`).join('\n')}` : '',
    '',
    `请针对这些薄弱点改编出 ${count} 道练习题，输出一个 JSON 数组，不要任何解释文字。`,
    '要求：',
    '1. 每题格式：{"type":"single|multi|judge","chapter":"对应薄弱章节名","stem":"题干","options":["A","B","C","D"],"answer":["A"],"analysis":"解析：说明考点","difficulty":"重点"}',
    '2. 单选/多选4个options，answer为字母数组；判断题options留空、answer为["对"]或["错"]',
    '3. difficulty 全部标 "重点"',
    '4. 只输出 JSON 数组本身',
  ].filter(Boolean)
  const text = await chatOnce([
    { role: 'system', content: '你是严谨的考证出题专家，永远只输出合法 JSON。' },
    { role: 'user', content: lines.join('\n') },
  ])
  const arr = extractJsonArray(text)
  return arr.filter((q) => q && typeof q.stem === 'string' && q.stem.trim() && Array.isArray(q.answer))
}
