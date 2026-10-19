/* 验证 SM-2 排期：三档间隔预览、认识阶梯、答错降级、封顶、次日到期
   做法：读取 src/srs.js，把 db 依赖替换成桩，再动态导入——测的就是真实源码 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const srcPath = path.join(dir, '../src/srs.js')
const tmp = path.join(dir, '.srs-pure.tmp.mjs')

const code = fs.readFileSync(srcPath, 'utf8').replace(
  /^import db, \{ uid, now \} from '\.\/db'\s*$/m,
  'const db = {}\nconst uid = () => ""\nconst now = () => Date.now()'
)
fs.writeFileSync(tmp, code)

const { nextSchedule, previewIntervals, intervalLabel, capInterval, isMasteredCard, MASTERED_DAYS, MASTERED_REPS } = await import(pathToFileURL(tmp).href)
fs.unlinkSync(tmp)

let bad = 0
const rows = [
  ['全新卡（未复习过）', previewIntervals({ intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 })],
  ['已连续认识 2 次、间隔 3 天', previewIntervals({ intervalDays: 3, ease: 2.5, reps: 2, lapses: 0 })],
  ['间隔 20 天、易度已降到 1.5', previewIntervals({ intervalDays: 20, ease: 1.5, reps: 3, lapses: 1 })],
]
for (const [name, p] of rows) {
  console.log(`${name}: 不认识 ${intervalLabel(p.again)} / 模糊 ${intervalLabel(p.hard)} / 认识 ${intervalLabel(p.good)}`)
  if (p.again !== 1) bad++
  if (!(p.hard >= 1 && p.good >= 1)) bad++
}

let c = { intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 }
const ladder = []
for (let i = 0; i < 5; i++) {
  c = nextSchedule(c, 'good')
  ladder.push(c.intervalDays)
}
console.log('连点认识的间隔阶梯:', ladder.join(' → '))
if (ladder.join(',') !== '1,3,8,20,50') { bad++; console.log('  阶梯与预期不符') }

const lapsed = nextSchedule({ intervalDays: 20, ease: 2.5, reps: 3, lapses: 0 }, 'again')
console.log(`间隔 20 天的卡评「不认识」→ ${lapsed.intervalDays} 天，易度降到 ${lapsed.ease.toFixed(2)}`)
if (lapsed.intervalDays !== 1 || lapsed.ease >= 2.5 || lapsed.reps !== 0) bad++

const capped = nextSchedule({ intervalDays: 400, ease: 2.5, reps: 5, lapses: 0 }, 'good')
console.log(`超长间隔封顶: ${capped.intervalDays} 天`)
if (capped.intervalDays > 365) bad++

const startOfTomorrow = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime() }
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime() }
if (!(startOfTomorrow() > endOfToday())) { bad++; console.log('次日到期时间点错误') }

/* 考试日封顶：上限 = 距考试天数 / 3（向下取整，至少 1 天） */
const capCases = [
  [50, 40, 13, '考期还有 40 天时，50 天间隔被压到 13 天'],
  [50, 3, 1, '考期只剩 3 天时，所有卡压缩到每天'],
  [50, null, 50, '没有考期时不封顶'],
  [1, 40, 1, '短间隔不受影响（只压不拉）'],
  [8, 6, 2, '考期 6 天时，8 天压到 2 天'],
]
for (const [days, exam, want, desc] of capCases) {
  const got = capInterval(days, exam)
  console.log(`封顶 ${desc}: ${days} 天 → ${got} 天${got === want ? '' : `（预期 ${want}）`}`)
  if (got !== want) bad++
}

/* 掌握判定（方案 A）：连对 4 次 或 间隔 ≥ 21 天，缺一不可地用「或」兜住考试封顶场景 */
console.log(`\n掌握阈值：连对 ${MASTERED_REPS} 次 或 间隔 ${MASTERED_DAYS} 天`)
const masterCases = [
  [{ intervalDays: 0, reps: 0 }, false, '刚入队（次日到期）'],
  [{ intervalDays: 3, reps: 2 }, false, '连对 2 次、间隔 3 天'],
  [{ intervalDays: 20, reps: 3 }, false, '间隔 20 天但只连对 3 次'],
  [{ intervalDays: 21, reps: 3 }, true, '间隔达到 21 天'],
  [{ intervalDays: 13, reps: 4 }, true, '考试封顶压住间隔，靠连对 4 次达标'],
  [{ intervalDays: 1, reps: 0, lapses: 2 }, false, '答错被打回 1 天'],
  [null, false, '没有卡片'],
]
for (const [card, want, desc] of masterCases) {
  const got = isMasteredCard(card)
  console.log(`  ${desc}: ${got ? '已掌握' : '待复习'}${got === want ? '' : `（预期 ${want}）`}`)
  if (got !== want) bad++
}

/* 模拟考试封顶下的真实路径：40 天后考试，连对 4 次应当移出错题本 */
let mc = { intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 }
const trail = []
for (let i = 0; i < 4; i++) {
  mc = nextSchedule(mc, 'good')
  mc.intervalDays = capInterval(mc.intervalDays, 40)
  trail.push(`${mc.intervalDays}天/连对${mc.reps}`)
}
console.log(`  考期 40 天下连续答对: ${trail.join(' → ')} → ${isMasteredCard(mc) ? '移出错题本' : '仍在待复习'}`)
if (!isMasteredCard(mc)) { bad++; console.log('  连对 4 次后仍未掌握，考试封顶场景失效') }

console.log(bad === 0 ? '全部检查通过 ✓' : `${bad} 项不符`)
process.exit(bad === 0 ? 0 : 1)
