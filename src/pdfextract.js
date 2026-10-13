/* PDF 讲义提取 + 章节切分（配合 aigen.js 逐章出题） */

/* 提取纯文本（文本层 PDF；扫描版无文本层会得到空串） */
export async function extractPdfText(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const workerMod = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
  let out = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    let pageText = ''
    for (const item of tc.items) {
      if (typeof item.str === 'string') {
        pageText += item.str
        if (item.hasEOL) pageText += '\n'
      }
    }
    out += pageText + '\n\n'
    page.cleanup()
  }
  doc.destroy()
  return out
}

const HEAD_RE = /^\s*(第\s*[0-9０-９一二三四五六七八九十百]+\s*[章讲部节课节]|专题\s*[一二三四五六七八九十\d]+|附录\s*[A-ZＡ-Ｚ一二三四五六七八九十]?)\s*/

/* 按「第x章 / 专题N」切分；找不到标题则整篇一节。过短的小节并入前一节 */
export function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/)
  const raw = []
  let cur = { title: '', parts: [] }
  for (const line of lines) {
    const t = line.trim()
    if (HEAD_RE.test(t) && t.length <= 30) {
      if (cur.parts.some((p) => p.trim())) raw.push(cur)
      cur = { title: t, parts: [] }
    } else {
      cur.parts.push(line)
    }
  }
  if (cur.parts.some((p) => p.trim())) raw.push(cur)

  // 无标题的过短碎段并入前一节；带标题的章节始终独立保留（短章也独立出题）
  const merged = []
  for (const sec of raw) {
    const content = sec.parts.join('\n').trim()
    if (merged.length && !sec.title && content.length < 200) {
      merged[merged.length - 1].content += '\n' + content
      continue
    }
    merged.push({ title: sec.title, content })
  }
  const result = merged.filter((s) => s.content.length >= 20)
  if (!result.length && text.trim()) {
    return [{ title: '', content: text.trim() }]
  }
  return result
}

/* 长章节按段落切成 ~maxChars 的块（同一 chapter 标题） */
export function chunkSection(sec, maxChars = 5000) {
  if (sec.content.length <= maxChars) return [{ ...sec }]
  const paras = sec.content.split(/\n{2,}/)
  const chunks = []
  let buf = ''
  for (const p of paras) {
    if ((buf + p).length > maxChars && buf) {
      chunks.push({ title: sec.title, content: buf })
      buf = p
    } else {
      buf += (buf ? '\n\n' : '') + p
    }
  }
  if (buf.trim()) chunks.push({ title: sec.title, content: buf })
  return chunks
}

/* 按篇幅定题量：约每 700 字 1 题，保底 4、封顶 10 */
export function countFor(len) {
  return Math.max(4, Math.min(10, Math.round(len / 700)))
}
