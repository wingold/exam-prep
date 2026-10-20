#!/usr/bin/env node
/* 把按章拆开的题目片段合并成一个题库 JSON，并逐题校验格式。
   为什么要拆：一个题库上百道题，一次写进单个文件容易漏逗号、错引号，
   且改不动一章就要重写全篇。片段一文件一章，合并时统一校验 + 去重 + 排序。

   用法：
     node scripts/merge-bank-fragments.mjs <片段目录> -o <输出json> \
        --name "城市管理学 01680 · 精讲题库" --subject 城市管理学 [--note "..."]
   片段目录里放 *.json，每个文件是一个题目数组。
*/
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { TYPES, isObjective } from '../src/questiontypes.js'

const argv = process.argv.slice(2)
const dir = argv.find((a) => !a.startsWith('-'))
const opt = (k, d = '') => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const out = opt('-o')
if (!dir || !out) {
  console.error('用法: node scripts/merge-bank-fragments.mjs <片段目录> -o <输出json> --name <题库名> --subject <科目>')
  process.exit(1)
}

const LETTERS = 'ABCDE'

function validate(q, file, idx) {
  const where = `${file} 第 ${idx + 1} 题`
  const bad = (msg) => {
    throw new Error(`${where}：${msg}`)
  }
  if (!q || typeof q !== 'object') bad('不是对象')
  const t = q.type
  if (!TYPES[t]) bad(`type 不在注册表内：${t}`)
  if (!q.stem || !String(q.stem).trim()) bad('stem 为空')
  if (!Array.isArray(q.answer) || !q.answer.length) bad('answer 必须是非空数组')
  if (!Array.isArray(q.options)) bad('options 必须是数组')

  if (isObjective(t)) {
    if (t === 'single' || t === 'multi') {
      if (q.options.length < 4) bad(`${t} 至少 4 个选项，实际 ${q.options.length}`)
      if (q.options.length > LETTERS.length) bad(`选项超过 ${LETTERS.length} 个`)
      if (q.options.some((o) => !String(o).trim())) bad('存在空选项')
      if (new Set(q.options.map((o) => String(o).trim())).size !== q.options.length) bad('选项有重复')
      if (q.answer.some((a) => !/^[A-E]$/.test(String(a).trim()))) bad(`答案必须是 A-E 字母：${q.answer}`)
      if (q.answer.some((a) => LETTERS.indexOf(a) >= q.options.length)) bad('答案字母超出选项范围')
      if (t === 'single' && q.answer.length !== 1) bad(`单选只能 1 个答案，实际 ${q.answer.length}`)
      if (t === 'multi' && q.answer.length < 2) bad(`多选至少 2 个答案，实际 ${q.answer.length}`)
    } else {
      // judge / fill 由导入器补默认选项，这里只查答案
      if (!String(q.answer[0] || '').trim()) bad('答案为空')
    }
  } else {
    // 主观题：不能带选项，答案是一段文字
    if (q.options.length) bad('主观题的 options 必须为空数组')
    if (q.answer.length !== 1) bad(`主观题答案应合并为 1 条，实际 ${q.answer.length} 条`)
    if (String(q.answer[0]).length < 10) bad('主观题答案过短，至少要写成要点')
  }
  if (!q.chapter || !String(q.chapter).trim()) bad('chapter 为空')
  return {
    type: t,
    chapter: String(q.chapter).trim(),
    stem: String(q.stem).trim(),
    options: q.options.map((o) => String(o).trim()),
    answer: q.answer.map((a) => String(a).trim()),
    analysis: String(q.analysis || '').trim(),
    ...(q.difficulty ? { difficulty: q.difficulty } : {}),
  }
}

const norm = (s) => s.replace(/[\s，。、；：？！“”‘’（）()《》【】,.;:?!]/g, '')

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
if (!files.length) {
  console.error('片段目录里没有 json：' + dir)
  process.exit(1)
}

const all = []
const seen = new Map()
let dup = 0
for (const f of files) {
  const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  if (!Array.isArray(arr)) {
    console.error(`${f} 不是数组`)
    process.exit(1)
  }
  arr.forEach((q, i) => {
    const v = validate(q, f, i)
    const key = v.type + '|' + norm(v.stem)
    if (seen.has(key)) {
      dup++
      return
    }
    seen.set(key, true)
    all.push(v)
  })
}

// 章序：按「第X章」排序，同一章内按题型（客观→主观）
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14 }
const chapNo = (c) => {
  const m = c.match(/第([一二三四五六七八九十]+)章/)
  return m ? CN[m[1]] || 99 : 99
}
const ORDER = Object.keys(TYPES)
all.sort((a, b) => chapNo(a.chapter) - chapNo(b.chapter) || ORDER.indexOf(a.type) - ORDER.indexOf(b.type))

const byType = {}
const byChapter = {}
for (const q of all) {
  byType[q.type] = (byType[q.type] || 0) + 1
  byChapter[q.chapter] = (byChapter[q.chapter] || 0) + 1
}

const bank = { name: opt('--name', '题库'), subject: opt('--subject', ''), note: opt('--note', '') }
if (!bank.note) delete bank.note
fs.writeFileSync(out, JSON.stringify({ version: 1, bank, questions: all }, null, 2), 'utf8')

console.log(`合并 ${files.length} 个片段 → ${all.length} 题${dup ? `（去重 ${dup} 题）` : ''}`)
console.log('题型：' + Object.entries(byType).map(([k, v]) => `${TYPES[k].label} ${v}`).join('、'))
console.log('章节：')
for (const [c, n] of Object.entries(byChapter).sort((a, b) => chapNo(a[0]) - chapNo(b[0]))) console.log(`  ${c}  ${n} 题`)
console.log('输出：' + out)
