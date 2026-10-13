<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import db, { getOrCreateCert, listSubjects, listSessions, subjectProgress } from '../db'
import { dueCount } from '../srs'

const router = useRouter()
const cert = ref(null)
const subjects = ref([])
const sessions = ref([])
const regs = ref([])
const wrongCount = ref(0)
const reviewDue = ref(0)
const progressMap = ref({})
const todayAttempts = ref(0)

onMounted(async () => {
  cert.value = await getOrCreateCert()
  subjects.value = await listSubjects(cert.value.id)
  sessions.value = await listSessions(cert.value.id)
  regs.value = await db.registrations.toArray()
  wrongCount.value = await db.wrongItems.where('status').equals('active').count()
  reviewDue.value = await dueCount()
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
        <div v-if="!subjects.length" class="tiny">先到进度页添加科目</div>
        <div v-for="s in subjects" :key="s.id" style="margin-bottom: 12px">
          <div class="row between" style="font-size: 13px; margin-bottom: 4px">
            <span>{{ s.name }}</span>
            <span class="tiny">{{ progressMap[s.id] || 0 }}%</span>
          </div>
          <div class="bar">
            <i
              :class="{ green: s.status === 'Passed' }"
              :style="{ width: (progressMap[s.id] || 0) + '%' }"
            ></i>
          </div>
        </div>
      </div>

      <!-- 今日任务 -->
      <div class="card">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px">今天</h3>
        <div style="font-size: 14px; margin-bottom: 10px">
          已作答 <b>{{ todayAttempts }}</b> 题 · 待复习错题 <b style="color: var(--red)">{{ wrongCount }}</b> 道
          · 今日记忆卡 <b style="color: var(--accent)">{{ reviewDue }}</b> 张
        </div>
        <div v-if="weakest" class="muted" style="margin-bottom: 14px">
          薄弱科目：{{ weakest.name }}（{{ progressMap[weakest.id] || 0 }}%），建议优先练习
        </div>
        <div class="row wrap">
          <button class="btn" @click="router.push('/practice?mode=review')">记忆复习（{{ reviewDue }}）</button>
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
