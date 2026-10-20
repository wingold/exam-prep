/* 同步信封的合并逻辑：纯函数，不碰 db、不碰网络，便于单测（scripts/verify-sync-delete.mjs）。
 *
 * 为什么需要墓碑（tombstone）：
 * 原来只按 updatedAt 做 last-write-wins，合并是「两边取并集」。
 * 本地删掉一条记录 = 本地没有它，远端还有它，并集里它就又出现了 ——
 * 于是「删掉的题库在同步后又回来了」。删除必须留下一条可传播的标记，
 * 否则「不存在」这件事根本无法被同步。
 *
 * 规则：
 * 1. 墓碑本身也走 LWW：同一 (table, recordId) 多次删除，只保留 at 最晚的一条。
 * 2. 墓碑生效的条件是 record 的写入时间 <= 墓碑时间。
 *    如果记录在删除之后又被更新过（时间戳更新），说明是「删除后又重建/改动」，保留记录。
 * 3. 墓碑超过保留期（180 天）自动失效并清理，否则这张表会永久堆积，
 *    也会让同步文件越来越大。180 天足够覆盖「隔很久才同步一次」的场景。
 */

/* 参与同步的表。注意不含 deletions —— 它由 mergeEnvelopes 单独合并，
   走的是「取最晚 at」而不是记录级的 LWW。 */
export const SYNC_TABLES = [
  'certificates', 'subjects', 'sessions', 'registrations', 'scores',
  'banks', 'questions', 'attempts', 'papers', 'results', 'wrongItems', 'cards',
  'decks', 'noteCards', 'plans',
]

export const TOMBSTONE_KEEP_DAYS = 180

export const tombstoneId = (table, recordId) => `${table}:${recordId}`

/* 记录的写入时间：不同表的时间字段不统一（updatedAt / at / createdAt） */
export function recordStamp(r) {
  if (!r) return 0
  return r.updatedAt || r.at || r.createdAt || 0
}

/* 记录级合并：同 id 取写入时间较晚的一方 */
export function mergeTable(localArr, remoteArr) {
  const map = new Map()
  for (const r of localArr || []) map.set(r.id, r)
  for (const r of remoteArr || []) {
    const l = map.get(r.id)
    if (!l) {
      map.set(r.id, r)
      continue
    }
    if (recordStamp(r) > recordStamp(l)) map.set(r.id, r)
  }
  return [...map.values()]
}

/* 合并两边的删除标记，丢弃过期项 */
export function mergeTombstones(localList, remoteList, { keepDays = TOMBSTONE_KEEP_DAYS, nowMs = Date.now() } = {}) {
  const cutoff = nowMs - keepDays * 86400e3
  const out = new Map()
  for (const d of [...(localList || []), ...(remoteList || [])]) {
    if (!d || !d.table || !d.recordId) continue
    if ((d.at || 0) < cutoff) continue
    const key = tombstoneId(d.table, d.recordId)
    const prev = out.get(key)
    if (!prev || (d.at || 0) > (prev.at || 0)) out.set(key, { ...d, id: key })
  }
  return [...out.values()]
}

/* 清理过期墓碑（本地库用，避免无限增长） */
export function pruneTombstones(list, { keepDays = TOMBSTONE_KEEP_DAYS, nowMs = Date.now() } = {}) {
  const cutoff = nowMs - keepDays * 86400e3
  return (list || []).filter((d) => d && (d.at || 0) >= cutoff)
}

/* 合并两个信封。
   返回 { merged, added, removed }：added/removed 是「相对本地」的净变化，
   用来判断要不要回写本地、以及给界面一句人话（+3 条 / -1 条）。 */
export function mergeEnvelopes(local, remote, opts = {}) {
  const src = local || { version: 1 }
  const merged = { ...src, version: 1 }

  const tombstones = mergeTombstones(src.deletions, remote && remote.deletions, opts)
  const tombMap = new Map(tombstones.map((d) => [d.id, d]))
  merged.deletions = tombstones

  let added = 0
  let removed = 0

  for (const t of SYNC_TABLES) {
    const localArr = src[t] || []
    const remoteArr = (remote && remote[t]) || []
    const union = mergeTable(localArr, remoteArr)

    // 应用墓碑：删除之后又被更新过的记录要留下
    const kept = union.filter((r) => {
      const d = tombMap.get(tombstoneId(t, r.id))
      if (!d) return true
      return recordStamp(r) > (d.at || 0)
    })

    const localIds = new Set(localArr.map((r) => r.id))
    const keptIds = new Set(kept.map((r) => r.id))
    for (const r of kept) if (!localIds.has(r.id)) added++
    for (const r of localArr) if (!keptIds.has(r.id)) removed++

    merged[t] = kept
  }

  return { merged, added, removed }
}
