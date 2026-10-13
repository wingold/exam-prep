import Dexie from 'dexie'

const db = new Dexie('exam-prep')

db.version(1).stores({
  certificates: 'id, name',
  subjects: 'id, certificateId, status, sortOrder',
  sessions: 'id, certificateId, examDate',
  registrations: 'id, sessionId, subjectId',
  scores: 'id, subjectId, sessionId, at',
  banks: 'id, subjectId, name, createdAt',
  questions: 'id, bankId, type, chapter',
  attempts: 'id, questionId, bankId, mode, at',
  papers: 'id, bankId, createdAt',
  results: 'id, paperId, bankId, at',
  wrongItems: 'id, questionId, status, updatedAt',
  meta: 'key',
})

db.version(2).stores({
  cards: 'id, dueAt, updatedAt',
})

export default db

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export const now = () => Date.now()

// Vue reactive Proxy 无法被 IndexedDB structured clone，入库前转纯对象
export const plain = (obj) => JSON.parse(JSON.stringify(obj))

/* ========== 证书 / 科目 / 考期 ========== */

export async function getOrCreateCert() {
  let cert = await db.certificates.toCollection().first()
  if (!cert) {
    cert = { id: uid(), name: '我的证书', org: '', createdAt: now() }
    await db.certificates.put(cert)
  }
  return cert
}

export async function listSubjects(certId) {
  return db.subjects.where('certificateId').equals(certId).sortBy('sortOrder')
}

export async function listSessions(certId) {
  const all = await db.sessions.where('certificateId').equals(certId).sortBy('examDate')
  return all
}

/* ========== 科目进度算法（PRD §3.4） ========== */

export async function subjectProgress(subjectId) {
  const banks = await db.banks.where('subjectId').equals(subjectId).toArray()
  if (!banks.length) return 0
  const bankIds = banks.map((b) => b.id)
  const questions = await db.questions.where('bankId').anyOf(bankIds).toArray()
  if (!questions.length) return 0

  // 1) 章节覆盖率 40%：该科目题库出现过的章节里，作答过的占比
  const chapters = new Set(questions.map((q) => q.chapter || '未分类'))
  const attempted = await db.attempts.where('bankId').anyOf(bankIds).toArray()
  const triedChapters = new Set(
    attempted.map((a) => {
      const q = questions.find((x) => x.id === a.questionId)
      return (q && q.chapter) || '未分类'
    })
  )
  let coverage = 0
  chapters.forEach((c) => { if (triedChapters.has(c)) coverage++ })
  const coverageRate = chapters.size ? coverage / chapters.size : 0

  // 2) 错题清空率 30%
  const qids = questions.map((q) => q.id)
  const wrongs = qids.length
    ? await db.wrongItems.where('questionId').anyOf(qids).toArray()
    : []
  const cleared = wrongs.filter((w) => w.status === 'cleared').length
  const clearRate = wrongs.length ? cleared / wrongs.length : 0

  // 3) 近 7 天正确率达标 30%：≥70% 满分，线性折算；无作答记 0
  const weekAgo = now() - 7 * 86400e3
  const recent = attempted.filter((a) => a.at >= weekAgo)
  let recentScore = 0
  if (recent.length) {
    const acc = recent.filter((a) => a.correct).length / recent.length
    recentScore = Math.min(acc / 0.7, 1)
  }

  return Math.round((0.4 * coverageRate + 0.3 * clearRate + 0.3 * recentScore) * 100)
}

/* ========== 全量导出 / 导入 ========== */

const TABLES = [
  'certificates', 'subjects', 'sessions', 'registrations', 'scores',
  'banks', 'questions', 'attempts', 'papers', 'results', 'wrongItems', 'cards', 'meta',
]

export async function exportAll() {
  const data = { version: 1, exportedAt: new Date().toISOString() }
  for (const t of TABLES) data[t] = await db[t].toArray()
  return data
}

export async function importAll(data, { mode = 'replace' } = {}) {
  if (!data || data.version !== 1) throw new Error('不是有效的备份文件（version≠1）')
  if (mode === 'replace') {
    for (const t of TABLES) await db[t].clear()
  }
  for (const t of TABLES) {
    if (Array.isArray(data[t])) await db[t].bulkPut(data[t])
  }
}
