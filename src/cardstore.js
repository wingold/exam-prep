/* 知识卡片：卡片组（deck）+ 卡片 CRUD + 导入解析 + 间隔重复 */

import db, { uid, now } from './db'
import { nextSchedule, endOfToday } from './srs'

/* ---------- 卡片组 ---------- */

export async function listDecks() {
  const decks = await db.decks.orderBy('createdAt').reverse().toArray()
  for (const d of decks) {
    d.count = await db.noteCards.where('deckId').equals(d.id).count()
    d.due = await db.noteCards.where('deckId').equals(d.id).and((c) => (c.dueAt || 0) <= endOfToday()).count()
  }
  return decks
}

export async function createDeck(name, source = '') {
  const deck = { id: uid(), name: name.trim() || '未命名卡片组', source, createdAt: now() }
  await db.decks.put(deck)
  return deck
}

export async function deleteDeck(deckId) {
  await db.noteCards.where('deckId').equals(deckId).delete()
  await db.decks.delete(deckId)
}

export function normalizeCard(c) {
  return {
    front: String(c.front ?? '').trim(),
    back: String(c.back ?? '').trim(),
    chapter: String(c.chapter ?? '').trim(),
    difficulty: /^(重点|高|是|y|yes|true|1)$/i.test(String(c.difficulty ?? '')) ? '重点' : String(c.difficulty ?? '').trim(),
  }
}

export async function addCards(deckId, cards, schedule = { mode: 'today' }) {
  const DAY = 86400e3
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const base = startOfToday.getTime()
  const list = cards.map((c, i) => {
    let dueAt = now()
    if (schedule.mode === 'spread') {
      // 每日投放 N 张：第 i 张排在第 floor(i/N) 天
      const perDay = Math.max(1, schedule.perDay || 10)
      dueAt = base + Math.floor(i / perDay) * DAY
    } else if (schedule.mode === 'delay') {
      // 推迟 X 天后统一开始
      dueAt = base + Math.max(0, schedule.delayDays || 0) * DAY
    }
    return {
      id: uid(),
      deckId,
      seq: i + 1,
      ...normalizeCard(c),
      intervalDays: 0,
      ease: 2.5,
      reps: 0,
      lapses: 0,
      dueAt,
      updatedAt: now(),
    }
  })
  await db.noteCards.bulkPut(list)
  return list.length
}

/* ---------- 背诵 ---------- */

export async function studyList(deckId, { mode = 'due', limit = 20, chapter = '' } = {}) {
  let list = await db.noteCards.where('deckId').equals(deckId).toArray()
  if (chapter) list = list.filter((c) => (c.chapter || '未分类') === chapter)
  if (mode === 'due') {
    const due = list.filter((c) => (c.dueAt || 0) <= endOfToday())
    list = due.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0)).slice(0, limit)
  } else {
    list = [...list].sort(() => Math.random() - 0.5).slice(0, limit)
  }
  return list
}

/* 组内章节统计：总张数 / 到期 / 掌握（答对≥2次） */
export async function deckChapters(deckId) {
  const cards = await db.noteCards.where('deckId').equals(deckId).toArray()
  const m = {}
  for (const c of cards) {
    const ch = c.chapter || '未分类'
    m[ch] = m[ch] || { chapter: ch, total: 0, due: 0, mastered: 0 }
    m[ch].total++
    if ((c.dueAt || 0) <= endOfToday()) m[ch].due++
    if ((c.reps || 0) >= 2) m[ch].mastered++
  }
  return Object.values(m).sort((a, b) => b.due - a.due || b.total - a.total)
}

export async function dueCount(deckId) {
  return db.noteCards.where('deckId').equals(deckId).and((c) => (c.dueAt || 0) <= endOfToday()).count()
}

export async function rateNoteCard(cardId, rating) {
  const card = await db.noteCards.get(cardId)
  if (!card) return
  await db.noteCards.update(cardId, { ...nextSchedule(card, rating), lastRatedAt: now() })
}

/* ---------- 复习计划（日/周/月目标） ---------- */

const PLAN_DEFAULTS = { day: 10, week: 50, month: 200 }
const PLAN_LABELS = { day: '今日', week: '本周', month: '本月' }

function periodStart(kind) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (kind === 'week') {
    const dow = (d.getDay() + 6) % 7 // 周一为一周开始
    d.setDate(d.getDate() - dow)
  } else if (kind === 'month') {
    d.setDate(1)
  }
  return d.getTime()
}

export async function getPlans() {
  const rows = await db.plans.toArray()
  const out = {}
  for (const kind of ['day', 'week', 'month']) {
    const row = rows.find((r) => r.kind === kind)
    out[kind] = {
      kind,
      label: PLAN_LABELS[kind],
      target: row?.target ?? PLAN_DEFAULTS[kind],
      deckId: row?.deckId || '',
    }
  }
  return out
}

export async function savePlan(plan) {
  await db.plans.put({
    id: plan.kind,
    kind: plan.kind,
    target: Math.max(1, Math.round(Number(plan.target) || PLAN_DEFAULTS[plan.kind])),
    deckId: plan.deckId || '',
    updatedAt: now(),
  })
}

/* 时段内完成数 = 该时段内评过分（lastRatedAt）且符合范围的卡片数 */
export async function planProgress(plan) {
  const start = periodStart(plan.kind)
  let list = await db.noteCards.where('lastRatedAt').above(start).toArray()
  if (plan.deckId) list = list.filter((c) => c.deckId === plan.deckId)
  return { done: list.length, target: plan.target }
}

/* ---------- 考前盘点：下个考期 × 报考科目 × 卡片掌握情况 ---------- */

export async function examReadiness() {
  const today = new Date().toISOString().slice(0, 10)
  const sessions = await db.sessions.orderBy('examDate').toArray()
  const session = sessions.find((s) => s.examDate >= today) || null
  if (!session) return { session: null, daysLeft: null, subjects: [] }
  const daysLeft = Math.max(0, Math.ceil((new Date(session.examDate) - new Date().setHours(0, 0, 0, 0)) / 86400e3))
  const regs = await db.registrations.where('sessionId').equals(session.id).toArray()
  const subjects = []
  for (const r of regs) {
    const subj = await db.subjects.get(r.subjectId)
    if (!subj || subj.status === 'Passed') continue
    const decks = await db.decks.where('subjectId').equals(subj.id).toArray()
    const deckInfos = []
    for (const d of decks) {
      const cards = await db.noteCards.where('deckId').equals(d.id).toArray()
      const mastered = cards.filter((c) => (c.reps || 0) >= 2).length
      const due = cards.filter((c) => (c.dueAt || 0) <= endOfToday()).length
      const byCh = {}
      for (const c of cards) {
        const ch = c.chapter || '未分类'
        byCh[ch] = byCh[ch] || { chapter: ch, total: 0, mastered: 0 }
        byCh[ch].total++
        if ((c.reps || 0) >= 2) byCh[ch].mastered++
      }
      const weakChapters = Object.values(byCh)
        .filter((v) => v.mastered < v.total)
        .sort((a, b) => (a.mastered / a.total) - (b.mastered / b.total))
      deckInfos.push({ id: d.id, name: d.name, total: cards.length, mastered, due, weakChapters })
    }
    subjects.push({ subject: subj, decks: deckInfos, noDeck: !decks.length })
  }
  return { session, daysLeft, subjects }
}

/* ---------- 直接导入解析 ---------- */

/* JSON：{version, deck:{name}, cards:[{front,back,chapter,difficulty}]} 或 cards 顶层数组 */
export function parseCardJson(text) {
  const data = JSON.parse(text)
  const deckName = data.deck?.name || data.name || ''
  let arr = data.cards || (Array.isArray(data) ? data : null)
  if (!Array.isArray(arr)) throw new Error('JSON 中未找到 cards 数组')
  arr = arr
    .map((c) => normalizeCard({ front: c.front ?? c.term ?? c.question, back: c.back ?? c.content ?? c.answer ?? c.definition, chapter: c.chapter, difficulty: c.difficulty }))
    .filter((c) => c.front && c.back)
  if (!arr.length) throw new Error('未解析出有效卡片（需要 front/back 字段）')
  return { deckName, cards: arr }
}

/* Excel：表头模糊匹配 正面|知识点|问题 / 反面|内容|要点|解释 / 章节 / 难度|重点 */
export function parseCardSheet(rows) {
  if (!rows.length) return { deckName: '', cards: [] }
  const header = rows[0].map((h) => String(h ?? '').trim())
  const find = (...keys) => {
    for (const k of keys) {
      const i = header.findIndex((h) => h.includes(k))
      if (i >= 0) return i
    }
    return -1
  }
  const iF = find('正面', '知识点', '问题', '概念', 'term')
  const iB = find('反面', '内容', '要点', '解释', '答案', 'definition', 'answer')
  const iC = find('章节', '分类')
  const iD = find('难度', '重点')
  if (iF < 0 || iB < 0) throw new Error('Excel 未找到「正面/知识点」或「反面/内容」列')
  const cards = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const c = normalizeCard({
      front: row[iF],
      back: row[iB],
      chapter: iC >= 0 ? row[iC] : '',
      difficulty: iD >= 0 ? row[iD] : '',
    })
    if (c.front && c.back) cards.push(c)
  }
  if (!cards.length) throw new Error('未解析出有效卡片行')
  return { deckName: '', cards }
}

/* 文本：# 章节行 + 「正面=>反面」（或「正面--反面」）每行一条 */
export function parseCardText(text) {
  const cards = []
  let chapter = ''
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const ch = line.match(/^(?:#|【章节】)\s*(.+)$/)
    if (ch) {
      chapter = ch[1].trim()
      continue
    }
    const m = line.match(/^(.+?)\s*(?:=>|->|——|--|\t)\s*(.+)$/)
    if (m) {
      cards.push(normalizeCard({ front: m[1], back: m[2], chapter }))
    }
  }
  if (!cards.length) throw new Error('未解析出卡片。文本格式：每行「正面=>反面」，可用「# 章节」分组')
  return { deckName: '', cards }
}
