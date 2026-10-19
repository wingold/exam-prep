/* 一次性验证：单题库导出 → 再导入，题目字段是否无损 */
import fs from 'node:fs'
import { parseJson } from '../src/importers.js'

const raw = JSON.parse(fs.readFileSync(new URL('../banks/测试题库-会计基础.json', import.meta.url), 'utf8'))
const srcBankName = raw.bank?.name || raw.name || ''
const srcQs = raw.questions || raw || []

if (!Array.isArray(srcQs)) throw new Error('源题库没有 questions 数组')

// 模拟 exportBank 的序列化（与 db.js 中 exportBank 的字段映射保持一致）
const exported = {
  version: 1,
  exportedAt: new Date().toISOString(),
  bank: { name: srcBankName, subject: raw.bank?.subject || '' },
  questions: srcQs.map((q) => ({
    type: q.type,
    chapter: q.chapter || '',
    stem: q.stem,
    options: q.type === 'judge' && !(q.options || []).length ? ['对', '错'] : (q.options || []),
    answer: q.answer || [],
    analysis: q.analysis || '',
    difficulty: q.difficulty || '',
  })),
}

const back = parseJson(JSON.stringify(exported))

let bad = 0
const cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const report = []
if (back.questions.length !== exported.questions.length) {
  bad++
  report.push(`题量不符：导出 ${exported.questions.length} → 回导 ${back.questions.length}`)
}
const n = Math.min(back.questions.length, exported.questions.length)
for (let i = 0; i < n; i++) {
  const a = exported.questions[i]
  const b = back.questions[i]
  for (const k of ['stem', 'chapter', 'type', 'analysis']) {
    if (!cmp(a[k], b[k])) { bad++; report.push(`#${i + 1} ${k} 不一致: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`) }
  }
  for (const k of ['options', 'answer']) {
    if (!cmp(a[k] || [], b[k] || [])) { bad++; report.push(`#${i + 1} ${k} 不一致: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`) }
  }
  const da = a.difficulty === '重点' ? '重点' : (a.difficulty || '')
  if (da !== (b.difficulty || '')) { bad++; report.push(`#${i + 1} difficulty 不一致: ${da} → ${b.difficulty}`) }
}

console.log(`题库：${exported.bank.name}，题量 ${exported.questions.length}`)
console.log(`回导题量：${back.questions.length}`)
console.log(bad === 0 ? '字段比对：全部一致 ✓' : `发现 ${bad} 处不一致：\n` + report.slice(0, 20).join('\n'))
process.exit(bad === 0 ? 0 : 1)
