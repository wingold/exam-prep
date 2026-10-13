<script setup>
import { ref, onMounted, computed } from 'vue'
import db from '../db'
import { aiReady } from '../ai'
import { aiStore, startDrillTask } from '../aistore'

const trend = ref([]) // [{date, total, right, rate}]
const chapters = ref([]) // [{bank, chapter, total, right, rate}]
const reasons = ref([]) // [[reason, n]]
const bankStats = ref([])
const attempts = ref([])
const results = ref([])
const weekCmp = ref([]) // 周对比 [{chapter, w1:{right,total,acc}, w2:{...}, delta, regressed}]

onMounted(async () => {
  await loadTrend()
  await loadChapters()
  await loadReasons()
  await loadBanks()
  await loadWeekCmp()
  results.value = await db.results.orderBy('at').reverse().limit(30).toArray()
})

/* 本周 vs 上周：分章节正确率对比，退步 ≥10pp 点名 */
async function loadWeekCmp() {
  const now = Date.now()
  const w1Start = now - 7 * 86400e3
  const w2Start = now - 14 * 86400e3
  const list = await db.attempts.where('at').aboveOrEqual(w2Start).toArray()
  const qmap = Object.fromEntries((await db.questions.toArray()).map((q) => [q.id, q]))
  const m = {}
  const bucket = (chapter, week, correct) => {
    m[chapter] = m[chapter] || { chapter, w1: { right: 0, total: 0 }, w2: { right: 0, total: 0 } }
    m[chapter][week].total++
    if (correct) m[chapter][week].right++
  }
  list.forEach((a) => {
    const q = qmap[a.questionId]
    if (!q) return
    const ch = q.chapter || '未分类'
    if (a.at >= w1Start) bucket(ch, 'w1', a.correct)
    else bucket(ch, 'w2', a.correct)
  })
  const accOf = (b) => (b.total ? Math.round((b.right / b.total) * 100) : null)
  weekCmp.value = Object.values(m)
    .map((r) => {
      const a1 = accOf(r.w1)
      const a2 = accOf(r.w2)
      const delta = a1 !== null && a2 !== null ? a1 - a2 : null
      return { ...r, a1, a2, delta, regressed: delta !== null && delta <= -10 }
    })
    .sort((a, b) => {
      if (a.delta === null) return 1
      if (b.delta === null) return -1
      return a.delta - b.delta
    })
    .slice(0, 12)
}

/* 近 14 天正确率趋势 */
async function loadTrend() {
  const since = Date.now() - 14 * 86400e3
  const list = await db.attempts.where('at').aboveOrEqual(since).toArray()
  attempts.value = list
  const byDay = {}
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3)
    const key = d.toISOString().slice(0, 10)
    byDay[key] = { date: key, total: 0, right: 0 }
  }
  list.forEach((a) => {
    const key = new Date(a.at).toISOString().slice(0, 10)
    if (byDay[key]) {
      byDay[key].total++
      if (a.correct) byDay[key].right++
    }
  })
  trend.value = Object.values(byDay).map((d) => ({ ...d, rate: d.total ? Math.round((d.right / d.total) * 100) : null }))
}

/* 章节掌握度 */
async function loadChapters() {
  const questions = await db.questions.toArray()
  const qmap = Object.fromEntries(questions.map((q) => [q.id, q]))
  const banks = await db.banks.toArray()
  const bmap = Object.fromEntries(banks.map((b) => [b.id, b]))
  const list = await db.attempts.toArray()
  const m = {}
  list.forEach((a) => {
    const q = qmap[a.questionId]
    if (!q) return
    const ch = q.chapter || '未分类'
    const key = ch
    m[key] = m[key] || { chapter: ch, bank: bmap[q.bankId]?.name || '', total: 0, right: 0, covered: new Set() }
    m[key].total++
    if (a.correct) m[key].right++
    m[key].covered.add(q.id)
  })
  chapters.value = Object.values(m)
    .map((x) => ({ ...x, rate: x.total ? Math.round((x.right / x.total) * 100) : 0, coverage: x.covered.size }))
    .sort((a, b) => a.rate - b.rate)
}

/* 错因占比 */
async function loadReasons() {
  const wrongs = await db.wrongItems.toArray()
  const m = {}
  wrongs.forEach((w) => (w.wrongReasons || []).forEach((r) => { m[r] = (m[r] || 0) + 1 }))
  reasons.value = Object.entries(m).sort((a, b) => b[1] - a[1])
}

async function loadBanks() {
  const banks = await db.banks.toArray()
  const out = []
  for (const b of banks) {
    const qs = await db.questions.where('bankId').equals(b.id).toArray()
    const attemptsB = await db.attempts.where('bankId').equals(b.id).toArray()
    const right = attemptsB.filter((a) => a.correct).length
    const tried = new Set(attemptsB.map((a) => a.questionId)).size
    out.push({
      name: b.name,
      total: qs.length,
      tried,
      rate: attemptsB.length ? Math.round((right / attemptsB.length) * 100) : null,
    })
  }
  bankStats.value = out
}

/* 近 14 天折线（SVG polyline，仅 1 天数据时画单点） */
const trendDots = computed(() => {
  const pts = trend.value.filter((t) => t.rate !== null)
  const w = 560, h = 140, pad = 8
  return pts.map((p, i) => ({
    x: pts.length === 1 ? w / 2 : pad + (i / (pts.length - 1)) * (w - pad * 2),
    y: pad + (1 - p.rate / 100) * (h - pad * 2),
  }))
})

const trendPoints = computed(() => {
  if (trendDots.value.length < 2) return ''
  return trendDots.value.map((p) => `${p.x},${p.y}`).join(' ')
})

const trendAvg = computed(() => {
  const pts = trend.value.filter((t) => t.rate !== null)
  if (!pts.length) return 0
  return Math.round(pts.reduce((s, p) => s + p.rate, 0) / pts.length)
})

const totalAttempts = computed(() => attempts.value.length)
const totalRight = computed(() => attempts.value.filter((a) => a.correct).length)
const overallRate = computed(() => (totalAttempts.value ? Math.round((totalRight.value / totalAttempts.value) * 100) : 0))

/* ---- AI 弱项出卷（后台任务，进度见悬浮球） ---- */
const aiGen = ref({ msg: '' })
const aiTaskRunning = computed(() => !!aiStore.task && ['extracting', 'generating'].includes(aiStore.task.phase))
const weakChapters = computed(() =>
  chapters.value.filter((c) => c.total >= 3).slice(0, 3).map((c) => ({ chapter: c.chapter, rate: c.rate }))
)

async function aiDrill() {
  if (!aiReady()) {
    alert('该功能需要 AI 模型：请先到「设置」页填写 Base URL / API Key / 模型名，再回来出题')
    return
  }
  if (aiTaskRunning.value) {
    alert('已有 AI 任务在后台生成中（见右下角进度球），等它完成再发起新的')
    return
  }
  if (!weakChapters.value.length) {
    alert('还没有足够的薄弱章节数据（需某章节作答 ≥3 题）')
    return
  }
  if (!confirm(`将针对「${weakChapters.value.map((c) => c.chapter).join('、')}」生成 8 道专项题并直接建库，确定？`)) return
  const wrongs = await db.wrongItems.where('status').equals('active').limit(12).toArray()
  const stems = []
  for (const w of wrongs) {
    const q = await db.questions.get(w.questionId)
    if (q) stems.push(q.stem)
  }
  // 后台运行：可离开本页，进度球全程跟进
  startDrillTask({ weakChapters: weakChapters.value, wrongStems: stems, count: 8 })
  aiGen.value.msg = '已在后台开始生成（约半分钟），可正常刷题；完成后右下角进度球会提醒你'
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>统计</h1>
      <div class="sub">练习趋势、章节掌握、错因分析</div>
    </div>

    <!-- 概览 -->
    <div class="grid3" style="margin-bottom: 16px">
      <div class="card" style="padding: 16px">
        <div class="tiny">近 14 天作答</div>
        <div style="font-size: 26px; font-weight: 800">{{ totalAttempts }}</div>
      </div>
      <div class="card" style="padding: 16px">
        <div class="tiny">总正确率</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--accent)">{{ overallRate }}%</div>
      </div>
      <div class="card" style="padding: 16px">
        <div class="tiny">日均正确率</div>
        <div style="font-size: 26px; font-weight: 800">{{ trendAvg }}%</div>
      </div>
    </div>

    <!-- 趋势 -->
    <div class="card" style="margin-bottom: 16px">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 4px">近 14 天正确率趋势</h3>
      <div class="tiny" style="margin-bottom: 10px">纵轴 0–100%，无作答的日期不显示</div>
      <div v-if="trendDots.length" style="overflow-x: auto">
        <svg :viewBox="'0 0 560 140'" width="100%" height="140" style="min-width: 400px; display: block">
          <line x1="8" y1="70" x2="552" y2="70" stroke="#e6e8ee" stroke-dasharray="4 4" />
          <line x1="8" y1="132" x2="552" y2="132" stroke="#e6e8ee" />
          <polyline v-if="trendPoints" :points="trendPoints" fill="none" stroke="#4f46e5" stroke-width="2.5" stroke-linejoin="round" />
          <circle v-for="(p, i) in trendDots" :key="i" :cx="p.x" :cy="p.y" r="4" fill="#4f46e5" />
          <text x="12" y="20" font-size="11" fill="#9aa3b2">100%</text>
          <text x="12" y="136" font-size="11" fill="#9aa3b2">0%</text>
        </svg>
        <div class="row between tiny" style="padding: 4px 8px">
          <span>{{ trend.find((t) => t.rate !== null)?.date }}</span>
          <span>{{ [...trend].reverse().find((t) => t.rate !== null)?.date }}</span>
        </div>
      </div>
      <div v-else class="empty" style="padding: 20px"><p>近 14 天还没有作答记录</p></div>
    </div>

    <!-- 周对比：退步点名 -->
    <div class="card" style="margin-bottom: 16px">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 4px">本周 vs 上周</h3>
      <div class="tiny" style="margin-bottom: 10px">分章节正确率对比，下降 ≥10 个百分点的标红点名，优先补</div>
      <div v-if="!weekCmp.length" class="empty" style="padding: 20px"><p>近两周还没有作答数据</p></div>
      <table v-else class="tbl">
        <thead>
          <tr><th>章节</th><th>上周</th><th>本周</th><th>变化</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in weekCmp" :key="r.chapter" :style="r.regressed ? 'background: var(--red-weak)' : ''">
            <td>
              {{ r.chapter }}
              <span v-if="r.regressed" class="tag red" style="margin-left: 6px">退步</span>
            </td>
            <td class="tiny">{{ r.a2 === null ? '—' : r.a2 + '%（' + r.w2.total + '题）' }}</td>
            <td class="tiny">{{ r.a1 === null ? '—' : r.a1 + '%（' + r.w1.total + '题）' }}</td>
            <td>
              <b v-if="r.delta === null" class="tiny">新增</b>
              <b v-else :style="{ color: r.delta >= 0 ? 'var(--green)' : 'var(--red)' }">
                {{ r.delta >= 0 ? '+' : '' }}{{ r.delta }}pp
              </b>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="grid2" style="margin-bottom: 16px">
      <!-- 章节掌握度：按正确率升序，最弱在前 -->
      <div class="card">
        <div class="row between" style="margin-bottom: 4px">
          <h3 style="font-size: 15px; font-weight: 700">章节掌握度</h3>
          <button class="btn sm" :disabled="aiTaskRunning" @click="aiDrill">
            {{ aiTaskRunning ? 'AI 后台生成中…' : 'AI 针对薄弱出题' }}
          </button>
        </div>
        <div class="tiny" style="margin-bottom: 10px">最弱的排最前，优先补；「AI 针对薄弱出题」按薄弱章节+近期错题生成专项题库（需先在设置页配置 AI；后台生成，可离开本页）</div>
        <p v-if="aiGen.msg" class="tiny" style="margin-bottom: 8px; color: var(--green)">{{ aiGen.msg }}</p>
        <div v-if="!chapters.length" class="empty" style="padding: 20px"><p>还没有作答数据</p></div>
        <div v-for="c in chapters.slice(0, 10)" :key="c.chapter" style="margin-bottom: 12px">
          <div class="row between" style="font-size: 13px; margin-bottom: 4px">
            <span>{{ c.chapter }}</span>
            <span class="tiny">{{ c.rate }}% · 做过 {{ c.coverage }} 题</span>
          </div>
          <div class="bar">
            <i :class="{ green: c.rate >= 80, amber: c.rate >= 60 && c.rate < 80 }"
               :style="{ width: c.rate + '%', background: c.rate < 60 ? 'var(--red)' : '' }"></i>
          </div>
        </div>
      </div>

      <!-- 错因占比 -->
      <div class="card">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 4px">错因分析</h3>
        <div class="tiny" style="margin-bottom: 10px">来自错题本的标注</div>
        <div v-if="!reasons.length" class="empty" style="padding: 20px"><p>错题还没有标注错因</p></div>
        <div v-for="[r, n] in reasons" :key="r" style="margin-bottom: 12px">
          <div class="row between" style="font-size: 13px; margin-bottom: 4px">
            <span>{{ r }}</span><span class="tiny">{{ n }}</span>
          </div>
          <div class="bar">
            <i :style="{ width: (n / reasons[0][1]) * 100 + '%' }" style="background: var(--red)"></i>
          </div>
        </div>
      </div>
    </div>

    <!-- 分题库 -->
    <div class="card" style="margin-bottom: 16px" v-if="bankStats.length">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 10px">分题库进度</h3>
      <table class="tbl">
        <thead><tr><th>题库</th><th>刷题进度</th><th>正确率</th></tr></thead>
        <tbody>
          <tr v-for="b in bankStats" :key="b.name">
            <td>{{ b.name }}</td>
            <td style="width: 40%">
              <div class="row" style="gap: 8px">
                <div class="bar" style="flex: 1">
                  <i :style="{ width: (b.total ? Math.round((b.tried / b.total) * 100) : 0) + '%' }"></i>
                </div>
                <span class="tiny" style="width: 64px">{{ b.tried }}/{{ b.total }}</span>
              </div>
            </td>
            <td>{{ b.rate === null ? '—' : b.rate + '%' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 考试历史 -->
    <div class="card" v-if="results.length">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 10px">模考历史</h3>
      <table class="tbl">
        <thead><tr><th>时间</th><th>成绩</th><th>对/总</th></tr></thead>
        <tbody>
          <tr v-for="r in results" :key="r.id">
            <td class="tiny">{{ new Date(r.at).toLocaleString() }}</td>
            <td><b :style="{ color: r.rate >= 60 ? 'var(--green)' : 'var(--red)' }">{{ r.rate }}%</b></td>
            <td>{{ r.right }}/{{ r.total }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
