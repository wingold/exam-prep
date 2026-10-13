/* 复习记忆：间隔重复调度（SM-2 简化版）
   三键：不认识 / 模糊 / 认识
   卡片随错题自动入队，答对按间隔滚入未来 */

import db, { uid, now } from './db'

const DAY = 86400e3

export const endOfToday = () => {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

/* 错题自动入队：已有卡片则提到今天 */
export async function enrollCard(questionId) {
  const existing = await db.cards.get(questionId)
  if (existing) {
    if (existing.dueAt > now()) {
      await db.cards.update(questionId, { dueAt: now(), updatedAt: now() })
    }
    return
  }
  await db.cards.put({
    id: questionId,
    dueAt: now(),
    intervalDays: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    updatedAt: now(),
  })
}

/* 评分调度 */
export async function rateCard(questionId, rating) {
  // rating: 'again' | 'hard' | 'good'
  const card = await db.cards.get(questionId)
  if (!card) return
  let { intervalDays, ease, reps, lapses } = card

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

  await db.cards.update(questionId, {
    intervalDays,
    ease,
    reps,
    lapses,
    dueAt: now() + intervalDays * DAY,
    updatedAt: now(),
  })
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
