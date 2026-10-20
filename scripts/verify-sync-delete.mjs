/* 同步删除（墓碑）验证：直接跑 src/merge.js 的真实实现，不复制逻辑。
 *
 * 背景：原来的合并是「两边取并集 + updatedAt LWW」，删除这件事根本传播不了 ——
 * 本地删了，远端还在，合并时又被并回来，于是「删掉的题库同步后又回来了」。
 * 这里把删除相关的边界逐条钉住，防止以后改合并逻辑时又退回去。
 *
 * 跑法：npm test（已串进 scripts.verify-sync-delete），或 node scripts/verify-sync-delete.mjs
 */

import {
  mergeEnvelopes,
  mergeTable,
  mergeTombstones,
  pruneTombstones,
  recordStamp,
  tombstoneId,
  TOMBSTONE_KEEP_DAYS,
} from '../src/merge.js'

let pass = 0
let fail = 0

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''))
  }
}

const ids = (arr) => (arr || []).map((x) => x.id).sort()
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const DAY = 86400e3
const NOW = 1_700_000_000_000
/* 墓碑时间要贴近「现在」，否则会被过期清理直接丢掉（那正是保留期的作用）。
   T0 = 30 天前，T_OLD 比它更早，T_MID / T_NEW 比它更晚。 */
const T0 = NOW - 30 * DAY
const T_OLD = T0 - DAY
const T_MID = T0 + 500
const T_NEW = T0 + 1000

/* 构造一条删除墓碑 */
const tomb = (table, recordId, at) => ({
  id: tombstoneId(table, recordId),
  table,
  recordId,
  at,
})

console.log('\n[1] 本地删除、云端仍有 → 不能复活')
{
  const local = { version: 1, banks: [], questions: [], deletions: [tomb('banks', 'b1', T0)] }
  const remote = { version: 1, banks: [{ id: 'b1', name: '会计基础', createdAt: T_OLD }] }
  const r = mergeEnvelopes(local, remote, { nowMs: NOW })
  check('合并后不含已删题库', r.merged.banks.length === 0, JSON.stringify(ids(r.merged.banks)))
  check('不算「新增」', r.added === 0, 'added=' + r.added)
  check('墓碑被保留（要能继续传给下一台设备）', r.merged.deletions.length === 1)
}

console.log('\n[2] 云端删除、本地仍有 → 本地也要删掉')
{
  const local = { version: 1, banks: [{ id: 'b1', name: '会计基础', createdAt: T_OLD }] }
  const remote = { version: 1, banks: [], deletions: [tomb('banks', 'b1', T0)] }
  const r = mergeEnvelopes(local, remote, { nowMs: NOW })
  check('合并后不含该题库', r.merged.banks.length === 0)
  check('removed 统计为 1（界面要显示 -1 条）', r.removed === 1, 'removed=' + r.removed)
}

console.log('\n[3] 没有墓碑时照常合并，不能误删')
{
  const local = { version: 1, banks: [{ id: 'b1', createdAt: T_OLD }] }
  const remote = { version: 1, banks: [{ id: 'b1', createdAt: T_OLD }, { id: 'b2', createdAt: T_MID }] }
  const r = mergeEnvelopes(local, remote, { nowMs: NOW })
  check('两边的记录都在', eq(ids(r.merged.banks), ['b1', 'b2']))
  check('added 统计为 1', r.added === 1, 'added=' + r.added)
  check('removed 为 0', r.removed === 0)
}

console.log('\n[4] 删除之后又被更新过（时间戳更新）→ 保留记录')
{
  const local = { version: 1, banks: [{ id: 'b1', updatedAt: T_NEW }] }
  const remote = { version: 1, banks: [{ id: 'b1', updatedAt: T_OLD }], deletions: [tomb('banks', 'b1', T0)] }
  const r = mergeEnvelopes(local, remote, { nowMs: NOW })
  check('比墓碑新的记录不被删', eq(ids(r.merged.banks), ['b1']))
}

console.log('\n[5] 两边都有墓碑 → 取最晚的那条')
{
  const local = { version: 1, banks: [], deletions: [tomb('banks', 'b1', T0)] }
  const remote = { version: 1, banks: [], deletions: [tomb('banks', 'b1', T_NEW)] }
  const r = mergeEnvelopes(local, remote, { nowMs: NOW })
  check('只保留一条墓碑（按 table:recordId 去重）', r.merged.deletions.length === 1)
  check('保留 at 较晚的一条', r.merged.deletions[0].at === T_NEW, String(r.merged.deletions[0].at))

  // 记录写入时间介于两次删除之间：以较晚的墓碑为准，应该被删
  const local2 = { version: 1, banks: [{ id: 'b1', updatedAt: T_MID }], deletions: [tomb('banks', 'b1', T0)] }
  const remote2 = { version: 1, banks: [{ id: 'b1', updatedAt: T_MID }], deletions: [tomb('banks', 'b1', T_NEW)] }
  const r2 = mergeEnvelopes(local2, remote2, { nowMs: NOW })
  check('记录时间早于最晚墓碑 → 删除生效', r2.merged.banks.length === 0)
}

console.log('\n[6] 题库连同题目一起删（127 题的真实规模）')
{
  const qs = Array.from({ length: 127 }, (_, i) => ({ id: 'q' + i, bankId: 'b1', seq: i }))
  const local = {
    version: 1,
    banks: [],
    questions: [],
    deletions: [tomb('banks', 'b1', T0), ...qs.map((q) => tomb('questions', q.id, T0))],
  }
  const remote = {
    version: 1,
    banks: [{ id: 'b1', createdAt: T_OLD }],
    questions: [...qs, { id: 'q-other', bankId: 'b2' }],
  }
  const r = mergeEnvelopes(local, remote, { nowMs: NOW })
  check('题库没有复活', r.merged.banks.length === 0)
  check('127 道题都没有复活', r.merged.questions.length === 1, '剩 ' + r.merged.questions.length)
  check('只留下别的题库的题', r.merged.questions[0].id === 'q-other')
}

console.log('\n[7] 墓碑过期（超过 ' + TOMBSTONE_KEEP_DAYS + ' 天）→ 不再生效')
{
  const old = NOW - (TOMBSTONE_KEEP_DAYS + 20) * DAY
  const local = { version: 1, banks: [], deletions: [tomb('banks', 'b1', old)] }
  const remote = { version: 1, banks: [{ id: 'b1', createdAt: T_OLD }] }
  const r = mergeEnvelopes(local, remote, { nowMs: NOW })
  check('过期墓碑被丢弃', r.merged.deletions.length === 0)
  check('过期后记录不再被压制（已知取舍，靠本地已删保证）', r.merged.banks.length === 1)

  const fresh = NOW - 10 * DAY
  const kept = pruneTombstones([tomb('banks', 'b1', old), tomb('banks', 'b2', fresh)], { nowMs: NOW })
  check('pruneTombstones 只留未过期的', kept.length === 1 && kept[0].recordId === 'b2')
}

console.log('\n[8] recordStamp 取时间字段的兜底顺序')
{
  check('优先 updatedAt', recordStamp({ updatedAt: 3, at: 2, createdAt: 1 }) === 3)
  check('其次 at', recordStamp({ at: 2, createdAt: 1 }) === 2)
  check('再次 createdAt', recordStamp({ createdAt: 1 }) === 1)
  check('都没有则为 0', recordStamp({}) === 0)
}

console.log('\n[9] mergeTable 仍是记录级 LWW')
{
  const l = [{ id: 'a', updatedAt: T_NEW, v: 'local' }]
  const r = [{ id: 'a', updatedAt: T_OLD, v: 'remote' }]
  check('保留写入较晚的一方', mergeTable(l, r)[0].v === 'local')
  check('反向也成立', mergeTable(r, l)[0].v === 'local')
}

console.log('\n[10] mergeTombstones 忽略残缺数据')
{
  const list = [
    { id: 'x', table: 'banks', recordId: 'b1', at: NOW - DAY },
    { id: 'y', at: NOW - DAY },              // 缺 table/recordId
    null,
    { id: 'z', table: '', recordId: 'b2', at: NOW - DAY },
  ]
  const out = mergeTombstones(list, [], { nowMs: NOW })
  check('只保留合法墓碑', out.length === 1 && out[0].recordId === 'b1', JSON.stringify(out.map((d) => d.id)))
}

console.log('\n' + (fail ? `❌ 同步删除检查：${pass} 通过 / ${fail} 失败` : `全部通过 ✓（${pass} 项）`))
process.exit(fail ? 1 : 0)
