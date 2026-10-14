/* 全局 AI 批处理任务 store：生成过程脱离页面存活，配合 FloatingBall 全站展示进度 */

import { reactive } from 'vue'
import db, { uid, now } from './db'
import { genQuestionsRaw, genWeakQuestions, genCardsRaw } from './aigen'
import { normalizeQuestion } from './importers'

if (!globalThis.__examPrepAiStore) {
  globalThis.__examPrepAiStore = reactive({
    task: null,
  })
}
export const aiStore = globalThis.__examPrepAiStore

let seq = 0

export function cancelTask() {
  if (aiStore.task) aiStore.task.cancelled = true
}

export function dismissTask() {
  if (aiStore.task && aiStore.task.phase !== 'running') aiStore.task = null
}

function newTask(partial) {
  aiStore.task = {
    id: ++seq,
    phase: 'running',
    cancelled: false,
    idx: 0,
    total: 0,
    got: 0,
    sectionTitle: '',
    error: '',
    warnings: [],
    result: null,
    consumed: false,
    ...partial,
  }
  return aiStore.task
}

/* ---------- PDF 讲义出题（后台） ---------- */

export async function startPdfTask(file) {
  const task = newTask({ kind: 'pdf', title: file.name, phase: 'extracting' })
  try {
    const { extractPdfText, splitSections, chunkSection, countFor } = await import('./pdfextract.js')
    const text = await extractPdfText(file)
    if (!text.trim()) {
      throw new Error(
        '这份 PDF 提取不到文字，几乎可以肯定是扫描版/图片型 PDF——目前不支持 OCR。' +
        '请改用带文字层的 PDF（打开后能选中复制文字的），或先转成 Word/纯文本后用「+ 导入题库」。'
      )
    }
    const sections = splitSections(text)
    if (!sections.length) throw new Error('PDF 内容为空')

    const jobs = []
    sections.forEach((sec) => chunkSection(sec, 5000).forEach((c) => jobs.push(c)))
    task.phase = 'generating'
    task.total = jobs.length

    const all = []
    for (let i = 0; i < jobs.length; i++) {
      if (task.cancelled) break
      const job = jobs[i]
      task.idx = i + 1
      task.sectionTitle = job.title || '前言/未命名段'
      try {
        const raw = await genQuestionsRaw(job.content, { chapter: job.title, count: countFor(job.content.length) })
        const qs = raw.map((q) => normalizeQuestion({ ...q, chapter: q.chapter || job.title })).filter((q) => q.stem)
        all.push(...qs)
        task.got = all.length
      } catch (e) {
        task.warnings.push(`「${task.sectionTitle}」失败：${e.message}`)
      }
      await new Promise((r) => setTimeout(r, 400))
    }

    if (!all.length && task.cancelled) {
      task.phase = 'cancelled'
      return
    }
    if (!all.length) {
      throw new Error(task.warnings.length ? '所有章节生成均失败：' + task.warnings[0] : '未生成任何题目')
    }
    task.phase = 'done'
    task.result = {
      bankName: file.name.replace(/\.pdf$/i, '') + '-AI出题',
      questions: all,
      fileName: file.name,
      warnings: task.warnings,
      cancelledPartial: task.cancelled,
    }
  } catch (e) {
    task.phase = 'error'
    task.error = e.message
  }
}

/* ---------- AI 弱项出卷（后台，直接入库） ---------- */

export async function startDrillTask({ weakChapters, wrongStems = [], count = 8 }) {
  const task = newTask({
    kind: 'drill',
    title: `AI 弱项出题：${weakChapters.map((c) => c.chapter).join('、')}`,
    phase: 'generating',
    total: 1,
  })
  try {
    task.sectionTitle = '分析薄弱点并出题'
    const raw = await genWeakQuestions({ weakChapters, wrongStems, count })
    if (task.cancelled) {
      task.phase = 'cancelled'
      return
    }
    const questions = raw.map((q) => normalizeQuestion(q)).filter((q) => q.stem)
    if (!questions.length) throw new Error('模型未返回有效题目，请重试')

    const bankId = uid()
    const d = new Date()
    const bankName = `AI弱项专项-${d.getMonth() + 1}月${d.getDate()}日`
    await db.banks.put({ id: bankId, subjectId: null, name: bankName, source: 'AI按薄弱章节生成', createdAt: now() })
    await db.questions.bulkPut(questions.map((q, i) => ({ id: uid(), bankId, seq: i + 1, ...q })))

    task.phase = 'done'
    task.got = questions.length
    task.result = { bankId, bankName, questions }
  } catch (e) {
    task.phase = 'error'
    task.error = e.message
  }
}

/* ---------- 知识卡片：讲义文件 → AI 摘取知识点（后台） ---------- */

export async function startCardsTask(file) {
  const task = newTask({ kind: 'cards', title: file.name, phase: 'extracting' })
  try {
    let text = ''
    const name = file.name.toLowerCase()
    if (name.endsWith('.pdf')) {
      const { extractPdfText } = await import('./pdfextract.js')
      text = await extractPdfText(file)
    } else if (name.endsWith('.docx')) {
      const mammoth = await import('mammoth/mammoth.browser')
      const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
      text = value
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      text = await file.text()
    } else {
      throw new Error('AI 摘取支持 .pdf / .docx / .txt / .md；JSON/Excel 请用「导入卡片」')
    }
    if (!text.trim()) {
      throw new Error(
        '这份文件提取不到文字（PDF 可能是扫描版/图片型，暂不支持 OCR）。' +
        '请改用带文字层的 PDF，或转成 Word/纯文本再试。'
      )
    }
    const { splitSections, chunkSection } = await import('./pdfextract.js')
    const sections = splitSections(text)
    const jobs = []
    ;(sections.length ? sections : [{ title: '', content: text.trim() }]).forEach((sec) =>
      chunkSection(sec, 5000).forEach((c) => jobs.push(c))
    )
    task.phase = 'generating'
    task.total = jobs.length

    const all = []
    for (let i = 0; i < jobs.length; i++) {
      if (task.cancelled) break
      const job = jobs[i]
      task.idx = i + 1
      task.sectionTitle = job.title || '前言/未命名段'
      try {
        const raw = await genCardsRaw(job.content, {
          chapter: job.title,
          count: Math.max(5, Math.min(12, Math.round(job.content.length / 900))),
        })
        const cards = raw
          .map((c) => ({ ...c, chapter: c.chapter || job.title }))
          .filter((c) => c.front && c.back)
        all.push(...cards)
        task.got = all.length
      } catch (e) {
        task.warnings.push(`「${task.sectionTitle}」失败：${e.message}`)
      }
      await new Promise((r) => setTimeout(r, 400))
    }

    if (!all.length && task.cancelled) {
      task.phase = 'cancelled'
      return
    }
    if (!all.length) {
      throw new Error(task.warnings.length ? '所有章节摘取均失败：' + task.warnings[0] : '未提取出任何卡片')
    }
    task.phase = 'done'
    task.result = {
      deckName: file.name.replace(/\.(pdf|docx|txt|md)$/i, '') + '-知识点',
      cards: all,
      fileName: file.name,
      warnings: task.warnings,
      cancelledPartial: task.cancelled,
    }
  } catch (e) {
    task.phase = 'error'
    task.error = e.message
  }
}
