#!/usr/bin/env node
/* 把课件 PDF 批量抽成文本，供人工/AI 出题时阅读。
   用法：
     node scripts/extract-pdf-text.mjs <输入目录> [-o 输出目录]
   默认输出到 .exam-tmp/pdf-text/，一个 PDF 一个 .txt（UTF-8）。
   注意：扫描件（无文字层）抽出来是空的，脚本会明确报出来，不会静默生成空文件。
*/
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')

const args = process.argv.slice(2)
const inputDir = args.find((a) => !a.startsWith('-'))
if (!inputDir) {
  console.error('用法: node scripts/extract-pdf-text.mjs <输入目录> [-o 输出目录]')
  process.exit(1)
}
const oIdx = args.indexOf('-o')
const outDir = oIdx >= 0 && args[oIdx + 1] ? args[oIdx + 1] : path.join('.exam-tmp', 'pdf-text')

fs.mkdirSync(outDir, { recursive: true })

const files = fs.readdirSync(inputDir).filter((f) => /\.pdf$/i.test(f)).sort()
if (!files.length) {
  console.error('目录里没有 PDF：' + inputDir)
  process.exit(1)
}

let totalChars = 0
for (const f of files) {
  const src = path.join(inputDir, f)
  const buf = new Uint8Array(fs.readFileSync(src))
  const doc = await getDocument({ data: buf, useSystemFonts: true, isEvalSupported: false }).promise
  const pages = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    // 按 item 的 y 坐标聚行，避免整页文字挤成一行
    const lines = new Map()
    for (const it of tc.items) {
      if (!it.str) continue
      const y = Math.round(it.transform[5] / 3) * 3
      if (!lines.has(y)) lines.set(y, [])
      lines.get(y).push(it.str)
    }
    const text = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, arr]) => arr.join('').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
    pages.push(text)
  }
  const out = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  const base = f.replace(/\.pdf$/i, '').replace(/\s*\(\d+\)$/, '').trim()
  const dest = path.join(outDir, base + '.txt')
  fs.writeFileSync(dest, out, 'utf8')
  totalChars += out.length
  const flag = out.length < 200 * doc.numPages * 0.3 ? '  ⚠ 文字层可能缺失' : ''
  console.log(`${f}\n  ${doc.numPages} 页 → ${out.length} 字 → ${dest}${flag}`)
}
console.log(`\n共 ${files.length} 个 PDF，${totalChars} 字`)
