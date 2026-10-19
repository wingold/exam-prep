/* 复习记忆：间隔重复调度（SM-2 简化版）
   三档：不认识 / 模糊 / 认识
   错题自动入队（次日生效），评分后按间隔滚入未来 */

import db, { uid, now } from './db'
import { getPrefs } from './prefs'

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
     而不是把零间隔拉回今天——那等于把错题本又刷一遍
   - force=true 用于用户手动「加入题卡复习」：不受设置页总开关限制 */
export async function enrollCard(questionId, { lapsed = false, force = false } = {}) {
  if (!force && !getPrefs().autoEnroll) return
  const existing = await db.cards.get(questionId)
  if (existing) {
    if (lapsed) {
      await db.cards.update(questionId, nextSchedule(existing, 'again'))
      await syncWrongItem(questionId)
    }
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
  await syncWrongItem(questionId)
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

/* ===== 掌握判定：唯一由排期决定（方案 A） =====
   记忆队列是唯一调度器，错题本只负责收录、标错因、展示。
   「掌握」＝ 连续 4 次没答错（reps ≥ 4）或 单卡间隔 ≥ 21 天。
   必须带 reps 这一条：叠加考试日封顶后，间隔会被压在「距考试天数/3」，
   临近考试时可能长期卡在 13 天，只按间隔判定会让错题永远移不出去。 */

export const MASTERED_REPS = 4
export const MASTERED_DAYS = 21

export function isMasteredCard(card) {
  if (!card) return false
  return (card.reps || 0) >= MASTERED_REPS || (card.intervalDays || 0) >= MASTERED_DAYS
}

/* 掌握状态的文字说明，供界面复用，避免各处口径不一 */
export function masteredHint(card) {
  const reps = card ? card.reps || 0 : 0
  const days = card ? card.intervalDays || 0 : 0
  return `连续答对 ${reps}/${MASTERED_REPS} 次 · 间隔 ${days} 天（满 ${MASTERED_DAYS} 天或连对 ${MASTERED_REPS} 次即掌握）`
}

/* 手动标记掌握的用户决定不参与自动回收 */
async function syncWrongItem(questionId) {
  const w = await db.wrongItems.where('questionId').equals(questionId).first()
  if (!w || w.clearedBy === 'user') return null
  const card = await db.cards.get(questionId)
  // 没有卡片的错题不动：没有排期依据时保持原状，避免把历史数据全部翻回待复习
  if (!card) return null
  const status = isMasteredCard(card) ? 'cleared' : 'active'
  if (w.status === status) return null
  await db.wrongItems.update(w.id, {
    status,
    clearedBy: status === 'cleared' ? 'srs' : null,
    updatedAt: now(),
  })
  return status
}

/* 全量对齐：页面加载时兜一次，保证列表与排期一致 */
export async function reconcileWrongBook() {
  const wrongs = await db.wrongItems.toArray()
  let changed = 0
  for (const w of wrongs) {
    if (w.clearedBy === 'user') continue
    const card = await db.cards.get(w.questionId)
    if (!card) continue
    const status = isMasteredCard(card) ? 'cleared' : 'active'
    if (w.status === status) continue
    await db.wrongItems.update(w.id, {
      status,
      clearedBy: status === 'cleared' ? 'srs' : null,
      updatedAt: now(),
    })
    changed++
  }
  return changed
}

/* 评分调度 */
export async function rateCard(questionId, rating) {
  const card = await db.cards.get(questionId)
  if (!card) return
  await db.cards.update(questionId, nextSchedule(card, rating))
  await syncWrongItem(questionId)
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

/* 未来 N 天每天到期的卡片数（逾期的并入今天）
   首页负载图用：只给一个「待复习 N」的数字看不出排期是否在工作，
   把 7 天的分布画出来，黑箱才变成可判断的东西。 */
export async function dueForecast(days = 7) {
  const cards = await db.cards.toArray()
  const today = startOfToday()
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(today + i * DAY)
    const label = i === 0 ? '今天' : i === 1 ? '明天' : `${d.getMonth() + 1}/${d.getDate()}`
    return { at: today + i * DAY, label, count: 0 }
  })
  for (const c of cards) {
    const due = c.dueAt || 0
    if (!Number.isFinite(due) || !due) continue
    let idx = Math.floor((due - today) / DAY)
    if (idx < 0) idx = 0 // 逾期未复习的并入今天
    if (idx >= days) continue // 更远的落在图外
    buckets[idx].count++
  }
  return buckets
}
