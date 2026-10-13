// 生成最小 ASCII 测试 PDF（Helvetica，用于验证 pdf.js 提取管线）
const fs = require('fs')
const lines = [
  'Intro paragraph without chapter heading. This is a lecture note.',
  '',
  'Chapter guide line text for testing extraction flow.',
  'Knowledge point one: the city is a permanent settlement with political structure.',
  'Knowledge point two: urban governance involves multiple stakeholders.',
  'Key concept: administrative division determines municipal authority boundaries.',
  '',
  'More content here so the section has enough characters for chunking tests.',
  'Another sentence about public administration and city management principles.',
  'Final line of the sample lecture notes content for parsing.',
]
const content = [
  'BT /F1 11 Tf 50 740 Td 14 TL',
  ...lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`),
  'ET',
].join('\n')

const objs = []
objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
objs[4] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

let pdf = '%PDF-1.4\n'
const offsets = []
for (let i = 1; i <= 5; i++) {
  offsets[i] = Buffer.byteLength(pdf)
  pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`
}
const xrefStart = Buffer.byteLength(pdf)
pdf += `xref\n0 6\n0000000000 65535 f \n`
for (let i = 1; i <= 5; i++) {
  pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
}
pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
fs.writeFileSync('D:/project/exam-prep/assets/test-lecture.pdf', pdf, 'latin1')
console.log('written', Buffer.byteLength(pdf), 'bytes')
