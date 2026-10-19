<script setup>
import { ref, computed, onMounted } from 'vue'
import db, { uid, now, getOrCreateCert, listSubjects, listSessions, subjectProgress } from '../db'
import { refreshExamCap } from '../srs'

const cert = ref(null)
const subjects = ref([])
const sessions = ref([])
const regs = ref([])
const scores = ref([])
const progressMap = ref({})

// 弹窗
const showSubj = ref(false)
const subjForm = ref({ id: '', name: '', passScore: 60 })
const showSession = ref(false)
const sessionForm = ref({ id: '', name: '', examDate: '', registerDeadline: '' })
const regSessionId = ref('')

const scoreDlg = ref(false)
const scoreForm = ref({ subjectId: '', sessionId: '', score: '' })

async function reload() {
  cert.value = await getOrCreateCert()
  subjects.value = await listSubjects(cert.value.id)
  sessions.value = await listSessions(cert.value.id)
  regs.value = await db.registrations.toArray()
  scores.value = await db.scores.toArray()
  const m = {}
  for (const s of subjects.value) m[s.id] = await subjectProgress(s.id)
  progressMap.value = m
}

onMounted(reload)

/* ---- 科目 ---- */
function editSubj(s) {
  subjForm.value = s
    ? { id: s.id, name: s.name, passScore: s.passScore }
    : { id: '', name: '', passScore: 60 }
  showSubj.value = true
}

async function saveSubj() {
  if (!subjForm.value.name.trim()) return
  if (subjForm.value.id) {
    await db.subjects.update(subjForm.value.id, {
      name: subjForm.value.name.trim(),
      passScore: Number(subjForm.value.passScore) || 60,
    })
  } else {
    await db.subjects.put({
      id: uid(),
      certificateId: cert.value.id,
      name: subjForm.value.name.trim(),
      passScore: Number(subjForm.value.passScore) || 60,
      status: 'NotRegistered',
      sortOrder: subjects.value.length + 1,
      updatedAt: now(),
    })
  }
  showSubj.value = false
  await reload()
}

async function delSubj(s) {
  if (!confirm(`删除科目「${s.name}」及其成绩记录？`)) return
  await db.subjects.delete(s.id)
  await db.scores.where('subjectId').equals(s.id).delete()
  await db.registrations.where('subjectId').equals(s.id).delete()
  await reload()
}

/* ---- 考期 ---- */
function editSession(s) {
  sessionForm.value = s
    ? { id: s.id, name: s.name, examDate: s.examDate, registerDeadline: s.registerDeadline || '' }
    : { id: '', name: '', examDate: '', registerDeadline: '' }
  showSession.value = true
}

async function saveSession() {
  if (!sessionForm.value.name.trim() || !sessionForm.value.examDate) return
  if (sessionForm.value.id) {
    await db.sessions.update(sessionForm.value.id, {
      name: sessionForm.value.name.trim(),
      examDate: sessionForm.value.examDate,
      registerDeadline: sessionForm.value.registerDeadline,
      updatedAt: now(),
    })
  } else {
    await db.sessions.put({
      id: uid(),
      certificateId: cert.value.id,
      name: sessionForm.value.name.trim(),
      examDate: sessionForm.value.examDate,
      registerDeadline: sessionForm.value.registerDeadline,
      updatedAt: now(),
    })
  }
  showSession.value = false
  await reload()
  await refreshExamCap() // 考试日变了，间隔上限要跟着变
}

async function delSession(s) {
  if (!confirm(`删除考期「${s.name}」及报考记录？`)) return
  await db.sessions.delete(s.id)
  await db.registrations.where('sessionId').equals(s.id).delete()
  await reload()
  await refreshExamCap()
}

/* ---- 报考：给某考期勾选科目 ---- */
const regDlg = ref(false)
const regChecked = ref({})

function openReg(session) {
  regSessionId.value = session.id
  const checked = {}
  subjects.value.forEach((s) => {
    const r = regs.value.find((x) => x.sessionId === session.id && x.subjectId === s.id)
    checked[s.id] = !!r
  })
  regChecked.value = checked
  regDlg.value = true
}

async function saveReg() {
  const sid = regSessionId.value
  await db.registrations.where('sessionId').equals(sid).delete()
  for (const [subjId, on] of Object.entries(regChecked.value)) {
    if (on) {
      await db.registrations.put({ id: uid(), sessionId: sid, subjectId: subjId, updatedAt: now() })
      const s = await db.subjects.get(subjId)
      if (s && s.status === 'NotRegistered') {
        await db.subjects.update(subjId, { status: 'Registered', updatedAt: now() })
      }
    }
  }
  regDlg.value = false
  await reload()
}

function registeredSubjects(sessionId) {
  const ids = regs.value.filter((r) => r.sessionId === sessionId).map((r) => r.subjectId)
  return subjects.value.filter((s) => ids.includes(s.id))
}

/* ---- 成绩录入 ---- */
function openScore(subject) {
  scoreForm.value = { subjectId: subject.id, sessionId: '', score: '' }
  scoreDlg.value = true
}

async function saveScore() {
  const { subjectId, sessionId, score } = scoreForm.value
  if (!sessionId || score === '') return
  const subj = await db.subjects.get(subjectId)
  const passed = Number(score) >= (subj.passScore || 60)
  await db.scores.put({
    id: uid(),
    subjectId,
    sessionId,
    score: Number(score),
    passed,
    at: now(),
  })
  await db.subjects.update(subjectId, {
    status: passed ? 'Passed' : 'Failed',
    updatedAt: now(),
  })
  scoreDlg.value = false
  await reload()
}

function scoreOf(subjectId) {
  const list = scores.value.filter((s) => s.subjectId === subjectId)
  return list.length ? list : null
}

function sessionName(id) {
  const s = sessions.value.find((x) => x.id === id)
  return s ? s.name : '?'
}

/* ---- 派生统计 ---- */
const passedCount = computed(() => subjects.value.filter((s) => s.status === 'Passed').length)
const activeSubjects = computed(() => subjects.value.filter((s) => s.status !== 'Passed'))
const passedSubjects = computed(() => subjects.value.filter((s) => s.status === 'Passed'))
const showArchived = ref(false)
const statusTag = (st) =>
  ({ Passed: 'green', Failed: 'red', Registered: 'accent', NotRegistered: '' }[st] || '')
const statusText = (st) =>
  ({ Passed: '已通过', Failed: '未通过', Registered: '已报考', NotRegistered: '未报考' }[st] || st)
</script>

<template>
  <div>
    <div class="page-head row between">
      <div>
        <h1>考证进度</h1>
        <div class="sub">{{ cert?.name }} · 共 {{ subjects.length }} 科，已过 {{ passedCount }} 科</div>
      </div>
    </div>

    <!-- 科目台账 -->
    <div class="card" style="margin-bottom: 16px">
      <div class="row between" style="margin-bottom: 12px">
        <h3 style="font-size: 15px; font-weight: 700">科目台账</h3>
        <button class="btn sm" @click="editSubj(null)">+ 添加科目</button>
      </div>
      <div v-if="!subjects.length" class="empty" style="padding: 24px">
        <p>还没有科目，先添加你的报考科目</p>
      </div>
      <!-- 桌面：表格 -->
      <table v-if="subjects.length" class="tbl desk-only">
        <thead>
          <tr><th>科目</th><th>状态</th><th>合格分</th><th>成绩</th><th>复习进度</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="s in activeSubjects" :key="s.id">
            <td><b>{{ s.name }}</b></td>
            <td><span class="tag" :class="statusTag(s.status)">{{ statusText(s.status) }}</span></td>
            <td>{{ s.passScore }}</td>
            <td>
              <template v-if="scoreOf(s.id)">
                <span v-for="sc in scoreOf(s.id)" :key="sc.id" style="margin-right: 6px">
                  <b :style="{ color: sc.passed ? 'var(--green)' : 'var(--red)' }">{{ sc.score }}</b>
                  <span class="tiny">（{{ sessionName(sc.sessionId) }}）</span>
                </span>
              </template>
              <span v-else class="tiny">—</span>
            </td>
            <td style="min-width: 120px">
              <div class="row" style="gap: 8px">
                <div class="bar" style="flex: 1"><i :style="{ width: (progressMap[s.id] || 0) + '%' }"></i></div>
                <span class="tiny" style="width: 34px; text-align: right">{{ progressMap[s.id] || 0 }}%</span>
              </div>
            </td>
            <td style="white-space: nowrap">
              <button class="btn ghost sm" @click="openScore(s)">录成绩</button>
              <button class="btn ghost sm" @click="editSubj(s)">编辑</button>
              <button class="btn ghost sm" @click="delSubj(s)">删</button>
            </td>
          </tr>
          <tr v-if="!activeSubjects.length">
            <td colspan="6" class="tiny" style="text-align: center; padding: 16px">全部科目都通过了，去归档里查看成绩 🎉</td>
          </tr>
        </tbody>
      </table>

      <!-- 桌面：已通过归档 -->
      <div v-if="passedSubjects.length" class="desk-only" style="margin-top: 14px">
        <button class="btn ghost sm" @click="showArchived = !showArchived">
          {{ showArchived ? '▾' : '▸' }} 已通过归档（{{ passedSubjects.length }} 科）
        </button>
        <table v-if="showArchived" class="tbl" style="margin-top: 10px; opacity: 0.85">
          <tbody>
            <tr v-for="s in passedSubjects" :key="s.id">
              <td>{{ s.name }}</td>
              <td><span class="tag green">已通过</span></td>
              <td>
                <template v-if="scoreOf(s.id)">
                  <span v-for="sc in scoreOf(s.id)" :key="sc.id" style="margin-right: 6px">
                    <b style="color: var(--green)">{{ sc.score }}</b>
                    <span class="tiny">（{{ sessionName(sc.sessionId) }}）</span>
                  </span>
                </template>
                <span v-else class="tiny">—</span>
              </td>
              <td style="white-space: nowrap; text-align: right">
                <button class="btn ghost sm" @click="editSubj(s)">编辑</button>
                <button class="btn ghost sm" @click="delSubj(s)">删</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 手机：卡片列表 -->
      <div v-if="subjects.length" class="mob-only">
        <div v-if="!activeSubjects.length" class="tiny" style="text-align: center; padding: 12px">
          全部科目都通过了，去归档里查看成绩 🎉
        </div>
        <div v-for="s in activeSubjects" :key="s.id" class="card" style="padding: 14px; margin-bottom: 10px; box-shadow: none">
          <div class="row between" style="margin-bottom: 4px">
            <b>{{ s.name }}</b>
            <span class="tag" :class="statusTag(s.status)">{{ statusText(s.status) }}</span>
          </div>
          <div class="tiny" style="margin-bottom: 8px">
            合格 {{ s.passScore }} 分
            <template v-if="scoreOf(s.id)">
              · 成绩
              <b v-for="sc in scoreOf(s.id)" :key="sc.id" :style="{ color: sc.passed ? 'var(--green)' : 'var(--red)', marginRight: '4px' }">
                {{ sc.score }}<span class="tiny">（{{ sessionName(sc.sessionId) }}）</span>
              </b>
            </template>
          </div>
          <div class="row" style="gap: 8px; margin-bottom: 10px">
            <div class="bar" style="flex: 1"><i :style="{ width: (progressMap[s.id] || 0) + '%' }"></i></div>
            <span class="tiny" style="width: 36px; text-align: right">{{ progressMap[s.id] || 0 }}%</span>
          </div>
          <div class="row" style="gap: 8px">
            <button class="btn ghost sm" @click="openScore(s)">录成绩</button>
            <button class="btn ghost sm" @click="editSubj(s)">编辑</button>
            <button class="btn ghost sm" @click="delSubj(s)">删</button>
          </div>
        </div>

        <!-- 手机：已通过归档 -->
        <div v-if="passedSubjects.length" style="margin-top: 6px">
          <button class="btn ghost sm" @click="showArchived = !showArchived">
            {{ showArchived ? '▾' : '▸' }} 已通过归档（{{ passedSubjects.length }} 科）
          </button>
          <template v-if="showArchived">
            <div v-for="s in passedSubjects" :key="s.id" class="card" style="padding: 12px 14px; margin-top: 10px; box-shadow: none; opacity: 0.85">
              <div class="row between" style="margin-bottom: 4px">
                <span>{{ s.name }}</span>
                <span class="tag green">已通过</span>
              </div>
              <div class="tiny" style="margin-bottom: 8px">
                <template v-if="scoreOf(s.id)">
                  <b v-for="sc in scoreOf(s.id)" :key="sc.id" style="color: var(--green)">
                    {{ sc.score }}<span class="tiny">（{{ sessionName(sc.sessionId) }}）</span>
                  </b>
                </template>
                <template v-else>—</template>
              </div>
              <div class="row" style="gap: 8px">
                <button class="btn ghost sm" @click="editSubj(s)">编辑</button>
                <button class="btn ghost sm" @click="delSubj(s)">删</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 考期与报考 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 12px">
        <h3 style="font-size: 15px; font-weight: 700">考期与报考计划</h3>
        <button class="btn sm" @click="editSession(null)">+ 添加考期</button>
      </div>
      <div v-if="!sessions.length" class="empty" style="padding: 24px">
        <p>添加考期后可记录每期报考科目</p>
      </div>
      <div v-for="s in sessions" :key="s.id" class="card" style="padding: 14px; margin-bottom: 10px; box-shadow: none">
        <div class="row between wrap">
          <div>
            <b>{{ s.name }}</b>
            <span class="muted" style="margin-left: 8px">考试日 {{ s.examDate }}</span>
            <span v-if="s.registerDeadline" class="tiny" style="margin-left: 6px">报考截止 {{ s.registerDeadline }}</span>
          </div>
          <div class="row" style="gap: 6px">
            <button class="btn ghost sm" @click="openReg(s)">报考科目</button>
            <button class="btn ghost sm" @click="editSession(s)">编辑</button>
            <button class="btn ghost sm" @click="delSession(s)">删</button>
          </div>
        </div>
        <div class="row wrap" style="margin-top: 8px" v-if="registeredSubjects(s.id).length">
          <span class="tag accent" v-for="sub in registeredSubjects(s.id)" :key="sub.id">{{ sub.name }}</span>
        </div>
        <div v-else class="tiny" style="margin-top: 6px">本期未报考科目</div>
      </div>
    </div>

    <!-- 科目弹窗 -->
    <div v-if="showSubj" class="modal-mask" @click.self="showSubj = false">
      <div class="modal">
        <h3>{{ subjForm.id ? '编辑科目' : '添加科目' }}</h3>
        <label class="field">
          <span class="lab">科目名称</span>
          <input class="input" v-model="subjForm.name" placeholder="如：财务管理" />
        </label>
        <label class="field">
          <span class="lab">合格分数</span>
          <input class="input" type="number" v-model.number="subjForm.passScore" />
        </label>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button class="btn ghost" @click="showSubj = false">取消</button>
          <button class="btn" @click="saveSubj">保存</button>
        </div>
      </div>
    </div>

    <!-- 考期弹窗 -->
    <div v-if="showSession" class="modal-mask" @click.self="showSession = false">
      <div class="modal">
        <h3>{{ sessionForm.id ? '编辑考期' : '添加考期' }}</h3>
        <label class="field">
          <span class="lab">考期名称</span>
          <input class="input" v-model="sessionForm.name" placeholder="如：2026年5月考期" />
        </label>
        <label class="field">
          <span class="lab">考试日期</span>
          <input class="input" type="date" v-model="sessionForm.examDate" />
        </label>
        <label class="field">
          <span class="lab">报考截止日期（可选）</span>
          <input class="input" type="date" v-model="sessionForm.registerDeadline" />
        </label>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button class="btn ghost" @click="showSession = false">取消</button>
          <button class="btn" @click="saveSession">保存</button>
        </div>
      </div>
    </div>

    <!-- 报考弹窗 -->
    <div v-if="regDlg" class="modal-mask" @click.self="regDlg = false">
      <div class="modal">
        <h3>本期报考科目</h3>
        <div v-for="s in subjects" :key="s.id" style="padding: 8px 0; border-bottom: 1px solid var(--line)">
          <label class="row" style="cursor: pointer">
            <input type="checkbox" v-model="regChecked[s.id]" />
            <span>{{ s.name }}</span>
            <span class="tag" :class="statusTag(s.status)" style="margin-left: auto">{{ statusText(s.status) }}</span>
          </label>
        </div>
        <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 16px">
          <button class="btn ghost" @click="regDlg = false">取消</button>
          <button class="btn" @click="saveReg">保存</button>
        </div>
      </div>
    </div>

    <!-- 成绩录入弹窗 -->
    <div v-if="scoreDlg" class="modal-mask" @click.self="scoreDlg = false">
      <div class="modal">
        <h3>录入成绩</h3>
        <label class="field">
          <span class="lab">科目</span>
          <select class="input" v-model="scoreForm.subjectId">
            <option v-for="s in subjects" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label class="field">
          <span class="lab">考期</span>
          <select class="input" v-model="scoreForm.sessionId">
            <option v-for="s in sessions" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label class="field">
          <span class="lab">分数</span>
          <input class="input" type="number" v-model="scoreForm.score" placeholder="如 72" />
        </label>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button class="btn ghost" @click="scoreDlg = false">取消</button>
          <button class="btn" @click="saveScore">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
