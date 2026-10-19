<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import db, { getOrCreateCert, listSubjects, listSessions, subjectProgress } from '../db'
import { dueCount, reconcileWrongBook } from '../srs'
import { getPlans, planProgress } from '../cardstore'

const router = useRouter()
const cert = ref(null)
const subjects = ref([])
const sessions = ref([])
const regs = ref([])
const wrongCount = ref(0)
const reviewDue = ref(0)
const noteDue = ref(0)
const planDay = ref(null) // { done, target }
const planWeek = ref(null)
const progressMap = ref({})
const todayAttempts = ref(0)

onMounted(async () => {
  cert.value = await getOrCreateCert()
  subjects.value = await listSubjects(cert.value.id)
  sessions.value = await listSessions(cert.value.id)
  regs.value = await db.registrations.toArray()
  // 错题的掌握状态由记忆排期决定，先对齐再统计，避免首页与错题本数字不一致
  await reconcileWrongBook()
  wrongCount.value = await db.wrongItems.where('status').equals('active').count()
  reviewDue.value = await dueCount()
  // 知识卡今日到期（全部组）
  const decks = await db.decks.toArray()
  let nd = 0
  for (const d of decks) nd += await db.noteCards.where('deckId').equals(d.id).and((c) => (c.dueAt || 0) <= new Date().setHours(23, 59, 59, 999)).count()
  noteDue.value = nd
  // 复习计划进度
  try {
    const plans = await getPlans()
    planDay.value = await planProgress(plans.day)
    planWeek.value = await planProgress(plans.week)
  } catch { /* 计划表未就绪时忽略 */ }
  const dayStart = new Date().setHours(0, 0, 0, 0)
  todayAttempts.value = await db.attempts.where('at').aboveOrEqual(dayStart).count()
  const m = {}
  for (const s of subjects.value) m[s.id] = await subjectProgress(s.id)
  progressMap.value = m
})

const passedCount = computed(() => subjects.value.filter((s) => s.status === 'Passed').length)

// 最近的未来考期 → 倒计时
const nextSession = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return sessions.value.find((s) => s.examDate >= today) || null
})

const daysLeft = computed(() => {
  if (!nextSession.value) return null
  const d = new Date(nextSession.value.examDate) - new Date().setHours(0, 0, 0, 0)
  return Math.max(0, Math.ceil(d / 86400e3))
})

// 本期报考科目
const regSubjects = computed(() => {
  if (!nextSession.value) return []
  const ids = regs.value.filter((r) => r.sessionId === nextSession.value.id).map((r) => r.subjectId)
  return subjects.value.filter((s) => ids.includes(s.id))
})

const upcoming = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  return sessions.value.filter((s) => s.examDate >= today).slice(0, 3)
})

const weakest = computed(() => {
  const started = subjects.value
    .filter((s) => (progressMap.value[s.id] || 0) > 0 && s.status !== 'Passed')
    .sort((a, b) => (progressMap.value[a.id] || 0) - (progressMap.value[b.id] || 0))
  return started[0] || null
})

// 总览只聚焦未通过科目；已通过的归档，不再占进度列表
const activeSubjects = computed(() => subjects.value.filter((s) => s.status !== 'Passed'))
</script>

<template>
  <div>
    <div class="page-head">
      <h1>总览</h1>
      <div class="sub">{{ cert?.name }}</div>
    </div>

    <!-- 签名时刻：考期倒计时 -->
    <div
      class="card"
      style="margin-bottom: 16px; background: linear-gradient(135deg, #4f46e5, #6d5bf0); border: none; color: #fff"
    >
      <template v-if="nextSession">
        <div class="row between wrap" style="align-items: flex-end">
          <div>
            <div style="font-size: 13px; opacity: 0.8">{{ nextSession.name }} 距考试还有</div>
            <div class="bignum" style="margin-top: 6px">
              {{ daysLeft }}<span style="font-size: 20px; font-weight: 600; margin-left: 6px">天</span>
            </div>
          </div>
          <div style="text-align: right; font-size: 13px; opacity: 0.9">
            <div>考试日 {{ nextSession.examDate }}</div>
            <div v-if="nextSession.registerDeadline">报考截止 {{ nextSession.registerDeadline }}</div>
            <div v-if="regSubjects.length" style="margin-top: 4px">
              本期报考：{{ regSubjects.map((s) => s.name).join('、') }}
            </div>
          </div>
        </div>
      </template>
      <template v-else>
        <div style="font-size: 15px">还没有考期，去<a href="#/progress" style="color: #fff; text-decoration: underline">进度页</a>添加考期与报考计划</div>
      </template>
    </div>

    <!-- 台账摘要 -->
    <div class="grid4" style="margin-bottom: 16px">
      <div class="card" style="padding: 16px">
        <div class="tiny">科目总数</div>
        <div style="font-size: 26px; font-weight: 800">{{ subjects.length }}</div>
      </div>
      <div class="card" style="padding: 16px">
        <div class="tiny">已通过</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--green)">{{ passedCount }}</div>
      </div>
      <div class="card" style="padding: 16px">
        <div class="tiny">待考科目</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--amber)">{{ subjects.length - passedCount }}</div>
      </div>
      <div class="card" style="padding: 16px">
        <div class="tiny">活跃错题</div>
        <div style="font-size: 26px; font-weight: 800; color: var(--red)">{{ wrongCount }}</div>
      </div>
    </div>

    <div class="grid2" style="margin-bottom: 16px">
      <!-- 各科进度 -->
      <div class="card">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px">各科复习进度</h3>
        <div v-if="!activeSubjects.length" class="tiny" style="padding: 8px 0">
          {{ subjects.length ? '全部科目已通过 🎉 进度页可查看归档成绩' : '先到进度页添加科目' }}
        </div>
        <div v-for="s in activeSubjects" :key="s.id" style="margin-bottom: 12px">
          <div class="row between" style="font-size: 13px; margin-bottom: 4px">
            <span>
              {{ s.name }}
              <span v-if="s.status === 'Failed'" class="tag red" style="margin-left: 4px">需重考</span>
            </span>
            <span class="tiny">{{ progressMap[s.id] || 0 }}%</span>
          </div>
          <div class="bar">
            <i :class="{ amber: s.status === 'Registered' }" :style="{ width: (progressMap[s.id] || 0) + '%' }"></i>
          </div>
        </div>
        <div v-if="passedCount" class="tiny" style="margin-top: 4px">
          已通过 {{ passedCount }} 科已归档，详见<a href="#/progress" style="color: var(--accent)">进度页</a>
        </div>
      </div>

      <!-- 今日任务 -->
      <div class="card">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px">今天</h3>
        <div style="font-size: 14px; margin-bottom: 10px">
          已作答 <b>{{ todayAttempts }}</b> 题 · 待复习错题 <b style="color: var(--red)">{{ wrongCount }}</b> 道
          · 题卡待复习 <b style="color: var(--accent)">{{ reviewDue }}</b> 张
          · 知识卡到期 <b style="color: var(--accent)">{{ noteDue }}</b> 张
        </div>
        <!-- 复习计划进度 -->
        <div v-if="planDay" style="margin-bottom: 10px">
          <div class="row between" style="font-size: 13px; margin-bottom: 4px">
            <span>📚 今日背诵 <b>{{ planDay.done }}</b> / {{ planDay.target }} 张</span>
            <span class="tiny">本周 {{ planWeek?.done ?? 0 }} / {{ planWeek?.target ?? '—' }}</span>
          </div>
          <div class="bar">
            <i :class="{ green: planDay.target && planDay.done >= planDay.target }"
               :style="{ width: (planDay.target ? Math.min(100, Math.round((planDay.done / planDay.target) * 100)) : 0) + '%' }"></i>
          </div>
          <router-link to="/cards" class="tiny" style="color: var(--accent)">调整目标与查看考前盘点 →</router-link>
        </div>
        <div v-if="weakest" class="muted" style="margin-bottom: 14px">
          薄弱科目：{{ weakest.name }}（{{ progressMap[weakest.id] || 0 }}%），建议优先练习
        </div>
        <div class="row wrap">
          <button class="btn" @click="router.push('/practice?mode=review')">题卡复习（{{ reviewDue }}）</button>
          <button class="btn ghost" @click="router.push('/cards')">背知识卡片</button>
          <button class="btn ghost" @click="router.push('/practice')">开始练习</button>
          <button class="btn ghost" @click="router.push('/wrong')">复习错题</button>
          <button class="btn ghost" @click="router.push('/exam')">模拟考试</button>
        </div>
      </div>
    </div>

    <!-- 近期考期 -->
    <div class="card" v-if="upcoming.length">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 10px">近期考期</h3>
      <table class="tbl">
        <thead><tr><th>考期</th><th>考试日</th><th>报考截止</th><th>报考科目</th></tr></thead>
        <tbody>
          <tr v-for="s in upcoming" :key="s.id">
            <td>{{ s.name }}</td>
            <td>{{ s.examDate }}</td>
            <td>{{ s.registerDeadline || '—' }}</td>
            <td>
              <template v-if="regs.filter((r) => r.sessionId === s.id).length">
                <span
                  class="tag accent"
                  style="margin-right: 4px"
                  v-for="sid in regs.filter((r) => r.sessionId === s.id).map((r) => r.subjectId)"
                  :key="sid"
                >{{ subjects.find((x) => x.id === sid)?.name }}</span>
              </template>
              <span v-else class="tiny">未报考</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
