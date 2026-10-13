/* AI 讲题：直连用户自己配置的 OpenAI 兼容接口，Key 只存本机 localStorage */

import db from './db'

const LS_KEY = 'ai_config'

export function getAIConfig() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || { baseUrl: '', apiKey: '', model: '' }
  } catch {
    return { baseUrl: '', apiKey: '', model: '' }
  }
}

export function setAIConfig(cfg) {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg))
}

export function aiReady() {
  const c = getAIConfig()
  return !!(c.baseUrl && c.apiKey && c.model)
}

export function buildQuestionPrompt(q, chosen) {
  const typeNames = { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '简答' }
  const opts = q.options?.length
    ? q.options.map((o, i) => `${'ABCDEF'[i]}. ${o}`).join('\n')
    : ''
  return [
    `题型：${typeNames[q.type] || q.type}`,
    q.chapter ? `章节：${q.chapter}` : '',
    `题干：${q.stem}`,
    opts ? `选项：\n${opts}` : '',
    `正确答案：${(q.answer || []).join('、') || '（见解析）'}`,
    q.analysis ? `已有解析：${q.analysis}` : '',
    chosen && chosen.length ? `我的选择：${chosen.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/* 流式请求，onToken 增量回调 */
export async function streamExplain({ question, chosen, extra }, onToken) {
  const cfg = getAIConfig()
  if (!aiReady()) throw new Error('未配置模型接口，请到设置页填写 Base URL / API Key / 模型名')

  const messages = [
    {
      role: 'system',
      content:
        '你是一位耐心的考证辅导老师。讲解题目时：先点破考点，再分析每个选项为什么对/错，最后给一句便于记忆的口诀或结论。使用简体中文，输出用 Markdown，控制在 300 字以内。',
    },
    {
      role: 'user',
      content:
        buildQuestionPrompt(question, chosen) +
        (extra ? `\n\n我的疑问：${extra}` : '') +
        '\n\n请讲解这道题。',
    },
  ]

  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, messages, stream: true }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`接口返回 ${res.status}：${t.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const data = s.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const j = JSON.parse(data)
        const delta = j.choices?.[0]?.delta?.content
        if (delta) onToken(delta)
      } catch {
        /* 忽略半行 */
      }
    }
  }
}
