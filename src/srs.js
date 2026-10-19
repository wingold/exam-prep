/* 复习记忆：间隔重复调度（SM-2 简化版）
   三档：不认识 / 模糊 / 认识
   错题自动入队（次日生效），评分后按间隔滚入未来 */

import db, { uid, now } from './db'

const DAY = 86400e3

export const endOfToday = () => {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

/* 明天 0 点：新入队的卡片次日才到期。
   当天刚做错的题当天再考一遍没有记忆价值，也会把"今日待复习"虚增。 */
export const startOfTomorrow = () => {
  const d = new Date()
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

export const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/* ===== 考试日封顶 =====
   纯 SM-2 只会把间隔越拉越长（1→3→8→20→50→125 天），
   备考周期内很容易把卡片排到考试之后，等于再也不会复习到。
   这里给间隔加一个上限：距最近考试天数 / 3，保证考前还能见到 2–3 次。 */

let examCapDays = null // 距最近未来考期的天数；null 表示没有未来考期

export function getExamCapDays() {
  return examCapDays
}

/* 纯函数，便于单测 */
export function capInterval(days, daysUntilExam) {
  if (daysUntilExam == null) return days
  return Math.min(days, Math.max(1, Math.floor(daysUntilExam / 3)))
}

export function examIntervalCap() {
  return examCapDays == null ? null : Math.max(1, Math.floor(examCapDays / 3))
}

/* 从考期表读取最近的未来考试日（模块级缓存，供同步的 nextSchedule 使用） */
export async function refreshExamCap() {
  const today = startOfToday()
  const all = await db.sessions.toArray()
  const upcoming = all
    .filter((s) => s && s.examDate)
    .map((s) => ({ t: Date.parse(`${s.examDate}T00:00:00`) }))
    .filter((x) => Number.isFinite(x.t) && x.t >= today)
    .sort((a, b) => a.t - b.t)
  examCapDays = upcoming.length ? Math.round((upcoming[0].t - today) / DAY) : null
  return examCapDays
}

/* 错题自动入队：
   - 第一次入队：次日到期，不占用今天的复习时间
   - 已在队列中且是"又答错了"：按「不认识」重新排期（明天再见、易度下调），
     而不是把零间隔拉回今天——那等于把错题本又刷一遍 */
export async function enrollCard(questionId, { lapsed = false } = {}) {
  const existing = await db.cards.get(questionId)
  if (existing) {
    if (lapsed) await db.cards.update(questionId, nextSchedule(existing, 'again'))
    return
  }
  await db.cards.put({
    id: questionId,
    dueAt: startOfTomorrow(),
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    updatedAt: now(),
  })
}

/* 纯调度函数：题目卡与知识卡共用（SM-2 简化） */
export function nextSchedule(card, rating) {
  let { intervalDays = 0, ease = 2.5, reps = 0, lapses = 0 } = card
  if (rating === 'again') {
    intervalDays = 1
    ease = Math.max(1.3, ease - 0.2)
    reps = 0
    lapses = (lapses || 0) + 1
  } else if (rating === 'hard') {
    ease = Math.max(1.3, ease - 0.15)
    intervalDays = Math.max(1, Math.round((intervalDays || 1) * 1.2))
    reps += 1
  } else {
    if (reps === 0) intervalDays = 1
    else if (reps === 1) intervalDays = 3
    else intervalDays = Math.round((intervalDays || 1) * ease)
    intervalDays = Math.min(intervalDays, 365)
    reps += 1
  }
  // 考试日封顶：间隔不越过"距考试天数/3"，避免卡片被排到考试之后
  intervalDays = capInterval(intervalDays, examCapDays)
  return { intervalDays, ease, reps, lapses, dueAt: now() + intervalDays * DAY, updatedAt: now() }
}

/* 三档评分各自会把下次复习推到多久：用于在按钮上直接显示，避免算法黑箱 */
export function previewIntervals(card) {
  const base = card || { intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 }
  return {
    again: nextSchedule(base, 'again').intervalDays,
    hard: nextSchedule(base, 'hard').intervalDays,
    good: nextSchedule(base, 'good').intervalDays,
  }
}

/* 间隔天数的口语化表达 */
export function intervalLabel(days) {
  const n = Math.max(1, Math.round(days || 1))
  return n <= 1 ? '明天' : `${n} 天后`
}

/* 评分调度 */
export async function rateCard(questionId, rating) {
  const card = await db.cards.get(questionId)
  if (!card) return
  await db.cards.update(questionId, nextSchedule(card, rating))
}

/* 今日到期的卡片（连题目一起返回） */
export async function dueCards() {
  const cards = await db.cards.where('dueAt').belowOrEqual(endOfToday()).toArray()
  const out = []
  for (const c of cards) {
    const q = await db.questions.get(c.id)
    if (q) out.push({ card: c, q })
  }
  out.sort((a, b) => a.card.dueAt - b.card.dueAt)
  return out
}

export async function dueCount() {
  return db.cards.where('dueAt').belowOrEqual(endOfToday()).count()
}
