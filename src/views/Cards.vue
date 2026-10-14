<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import * as XLSX from 'xlsx'
import db, { getOrCreateCert, listSubjects } from '../db'
import { aiReady } from '../ai'
import { aiStore, startCardsTask, cancelTask } from '../aistore'
import {
  listDecks, createDeck, deleteDeck, addCards,
  studyList, rateNoteCard, parseCardJson, parseCardSheet, parseCardText,
  deckChapters, getPlans, savePlan, planProgress, examReadiness,
} from '../cardstore'

const view = ref('list') // list | preview | study | plan
const decks = ref([])
const subjects = ref([])
const preview = ref(null) // { deckName, cards, fileName, warnings, sourceKind }
const newDeckName = ref('')
const needAiCfg = ref(false)
const aiInput = ref(null)
const directInput = ref(null)
const studyMsg = ref('')
const session = ref(null) // { deckName, deckId, list, idx, flipped, chapter, chapStats }
const pickerDeck = ref(null) // 按章节背：当前选中的组
const pickerChapters = ref([])
const plans = ref(null) // { day:{...}, week:{...}, month:{...} }
const planProg = ref({})
const readiness = ref(null)
const schedMode = ref('today') // today | spread | delay
const schedPerDay = ref(10)
const schedDelay = ref(3)

const cardsTask = computed(() => (aiStore.task && aiStore.task.kind === 'cards' ? aiStore.task : null))
const cur = computed(() => (session.value ? session.value.list[session.value.idx] : null))

onMounted(async () => {
  await reload()
  const cert = await getOrCreateCert()
  subjects.value = await listSubjects(cert.id)
  consumeAiResult()
  window.addEventListener('keydown', onKey)
})

// 停在本页等待时，任务完成也要立即进入预览（监听 phase 字符串，对象原地变更不触发引用比较）
watch(() => cardsTask.value && cardsTask.value.phase, (p) => {
  if (p === 'done') consumeAiResult()
})

function consumeAiResult() {
  const t = aiStore.task
  if (t && t.kind === 'cards' && (t.phase === 'done' || (t.phase === 'cancelled' && t.got)) && t.result && !t.consumed) {
    preview.value = { ...t.result, sourceKind: 'ai' }
    newDeckName.value = t.result.deckName || ''
    t.consumed = true
    view.value = 'preview'
  }
}

onUnmounted(() => window.removeEventListener('keydown', onKey))

async function reload() {
  decks.value = await listDecks()
}

/* ---------- 导入 ---------- */

function onAiFilePick(ev) {
  const f = ev.target.files?.[0]
  if (!f) return
  ev.target.value = ''
  if (!aiReady()) {
    needAiCfg.value = true
    return
  }
  needAiCfg.value = false
  startCardsTask(f)
}

async function onDirectFilePick(ev) {
  const f = ev.target.files?.[0]
  if (!f) return
  ev.target.value = ''
  try {
    const name = f.name.toLowerCase()
    let result
    if (name.endsWith('.json')) {
      result = parseCardJson(await f.text())
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      result = parseCardSheet(rows)
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      result = parseCardText(await f.text())
    } else {
      throw new Error('支持 .json / .xlsx / .csv / .txt（文本格式：每行「正面=>反面」）')
    }
    preview.value = { ...result, fileName: f.name, warnings: [], sourceKind: 'direct' }
    newDeckName.value = result.deckName || f.name.replace(/\.[^.]+$/, '')
    view.value = 'preview'
  } catch (e) {
    alert('导入失败：' + e.message)
  }
}

async function confirmImport() {
  if (!preview.value || !preview.value.cards.length) return
  const deck = await createDeck(newDeckName.value || preview.value.deckName || '未命名卡片组', preview.value.fileName)
  const schedule =
    schedMode.value === 'spread'
      ? { mode: 'spread', perDay: Math.max(1, Number(schedPerDay.value) || 10) }
      : schedMode.value === 'delay'
        ? { mode: 'delay', delayDays: Math.max(0, Number(schedDelay.value) || 0) }
        : { mode: 'today' }
  await addCards(deck.id, preview.value.cards, schedule)
  studyMsg.value = `已创建「${deck.name}」${preview.value.cards.length} 张卡片`
  preview.value = null
  view.value = 'list'
  await reload()
}

function cancelPreview() {
  preview.value = null
  view.value = 'list'
}

function cancelAiTask() {
  cancelTask()
}

/* ---------- 背诵 ---------- */

async function startStudy(deck, mode, chapter = '') {
  const list = await studyList(deck.id, {
    mode,
    limit: mode === 'due' ? 50 : 10,
    chapter,
  })
  if (!list.length) {
    alert(
      mode === 'due'
        ? `「${chapter || deck.name}」今天没有到期的卡片，试试随机背几张`
        : '这个范围内还没有卡片'
    )
    closePicker()
    return
  }
  let chapStats = null
  if (chapter) {
    const all = (await db.noteCards.where('deckId').equals(deck.id).toArray())
      .filter((c) => (c.chapter || '未分类') === chapter)
    chapStats = {
      chapter,
      total: all.length,
      mastered: all.filter((c) => (c.reps || 0) >= 2).length,
    }
  }
  session.value = {
    deckName: deck.name,
    deckId: deck.id,
    list,
    idx: 0,
    flipped: false,
    chapter,
    chapStats,
  }
  studyMsg.value = ''
  view.value = 'study'
  closePicker()
  await nextTick()
}

function flip() {
  if (session.value) session.value.flipped = !session.value.flipped
}

async function rate(r) {
  if (!session.value || !session.value.flipped) return
  await rateNoteCard(cur.value.id, r)
  if (session.value.idx + 1 >= session.value.list.length) {
    studyMsg.value = `背完 ${session.value.list.length} 张 ✓`
    session.value = null
    view.value = 'list'
    await reload()
  } else {
    session.value.idx++
    session.value.flipped = false
  }
}

function quitStudy() {
  studyMsg.value = session.value ? `已背 ${session.value.idx} 张` : ''
  session.value = null
  view.value = 'list'
  reload()
}

function onKey(e) {
  if (view.value !== 'study' || !session.value) return
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault()
    flip()
  } else if (session.value.flipped) {
    if (e.key === '1') rate('again')
    if (e.key === '2') rate('hard')
    if (e.key === '3') rate('good')
  }
}

async function delDeck(d) {
  if (!confirm(`删除卡片组「${d.name}」及其 ${d.count} 张卡片？`)) return
  await deleteDeck(d.id)
  if (pickerDeck.value && pickerDeck.value.id === d.id) closePicker()
  await reload()
}

/* ---------- 按章节背 ---------- */

async function openPicker(d) {
  pickerDeck.value = d
  pickerChapters.value = await deckChapters(d.id)
}

function closePicker() {
  pickerDeck.value = null
  pickerChapters.value = []
}

/* ---------- 卡片组归属科目 ---------- */

async function assignDeckSubject(d, ev) {
  d.subjectId = ev.target.value || null // 本地即时刷新下拉显示
  await db.decks.update(d.id, { subjectId: d.subjectId })
}

/* ---------- 复习计划 + 考前盘点 ---------- */

async function openPlan() {
  plans.value = await getPlans() // 先加载再切视图，避免渲染空引用
  view.value = 'plan'
  for (const kind of ['day', 'week', 'month']) {
    planProg.value[kind] = await planProgress(plans.value[kind])
  }
  readiness.value = await examReadiness()
}

function backToList() {
  view.value = 'list'
}

async function updateTarget(kind, ev) {
  const p = plans.value[kind]
  p.target = Number(ev.target.value) || p.target
  await savePlan(p)
  planProg.value[kind] = await planProgress(p)
}

async function updatePlanDeck(kind, ev) {
  const p = plans.value[kind]
  p.deckId = ev.target.value || ''
  await savePlan(p)
  planProg.value[kind] = await planProgress(p)
}

const totalCards = computed(() => decks.value.reduce((s, d) => s + d.count, 0))
const pctOf = (done, target) => Math.min(100, target ? Math.round((done / target) * 100) : 0)
</script>

<template>
  <div>
    <!-- ===== 背诵中 ===== -->
    <template v-if="view === 'study' && session && cur">
      <div class="row between" style="margin-bottom: 6px">
        <div class="row" style="gap: 10px">
          <span class="tag accent">背卡片</span>
          <span class="tiny">{{ session.deckName }} · 本次 {{ session.idx + 1 }} / {{ session.list.length }}</span>
        </div>
        <button class="btn ghost sm" @click="quitStudy">退出</button>
      </div>
      <div v-if="session.chapStats" class="tiny" style="margin-bottom: 8px">
        本章「{{ session.chapStats.chapter }}」：共 {{ session.chapStats.total }} 张 · 已掌握
        <b style="color: var(--green)">{{ session.chapStats.mastered }}</b>
        · 本章进度
        <b>{{ session.idx }}/{{ session.list.length }}</b>
      </div>
      <div class="bar" style="margin-bottom: 16px">
        <i :style="{ width: (session.idx / session.list.length) * 100 + '%' }"></i>
      </div>

      <div class="kcard" :class="{ flipped: session.flipped }" @click="flip">
        <div class="kcard-inner">
          <div class="kface front">
            <div class="row between" style="margin-bottom: 10px">
              <span class="tiny">{{ cur.chapter || '' }}</span>
              <span v-if="cur.difficulty === '重点'" class="tag red">重点</span>
            </div>
            <div style="font-size: 18px; font-weight: 700; white-space: pre-wrap">{{ cur.front }}</div>
            <div class="tiny" style="margin-top: auto; text-align: center">点击卡片 / 空格 翻面看答案</div>
          </div>
          <div class="kface back">
            <div class="row between" style="margin-bottom: 10px">
              <span class="tiny">背面</span>
              <span v-if="cur.difficulty === '重点'" class="tag red">重点</span>
            </div>
            <div style="font-size: 16px; white-space: pre-wrap; overflow-y: auto">{{ cur.back }}</div>
          </div>
        </div>
      </div>

      <div v-if="session.flipped" class="row" style="gap: 10px; margin-top: 16px">
        <button class="btn danger" style="flex: 1" @click="rate('again')">不认识</button>
        <button class="btn ghost" style="flex: 1; border-color: var(--amber); color: var(--amber)" @click="rate('hard')">模糊</button>
        <button class="btn" style="flex: 1; background: var(--green)" @click="rate('good')">认识</button>
      </div>
      <div class="tiny" style="margin-top: 10px; text-align: center">键盘：空格翻面 · 1 不认识 · 2 模糊 · 3 认识</div>
    </template>

    <!-- ===== 导入预览 ===== -->
    <template v-else-if="view === 'preview' && preview">
      <div class="page-head">
        <h1>确认导入卡片</h1>
        <div class="sub">共 {{ preview.cards.length }} 张 · 来源 {{ preview.fileName }}</div>
      </div>
      <div class="card" style="border-color: var(--accent); margin-bottom: 14px">
        <div v-if="preview.warnings?.length" class="tiny" style="color: var(--amber); margin-bottom: 8px">
          ⚠ {{ preview.warnings.length }} 段失败：{{ preview.warnings[0] }}
        </div>
        <label class="field">
          <span class="lab">卡片组名称</span>
          <input class="input" v-model="newDeckName" placeholder="如：城市管理学-必背" />
        </label>

        <!-- 新卡安排 -->
        <div class="lab" style="font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 6px">新卡安排（决定「今日到期」怎么算）</div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; font-size: 14px">
          <label class="row" style="cursor: pointer; gap: 8px">
            <input type="radio" v-model="schedMode" value="today" />
            <span>立即到期——导入后今天就能全部开背</span>
          </label>
          <label class="row" style="cursor: pointer; gap: 8px">
            <input type="radio" v-model="schedMode" value="spread" />
            <span>每日投放
              <input class="input" style="width: 70px; display: inline-block; margin: 0 4px" type="number" min="1" v-model.number="schedPerDay" :disabled="schedMode !== 'spread'" />
              张——新卡分几天排队，今天只到期前 N 张</span>
          </label>
          <label class="row" style="cursor: pointer; gap: 8px">
            <input type="radio" v-model="schedMode" value="delay" />
            <span>推迟
              <input class="input" style="width: 70px; display: inline-block; margin: 0 4px" type="number" min="0" v-model.number="schedDelay" :disabled="schedMode !== 'delay'" />
              天后开始——全部卡片从那天起才到期</span>
          </label>
        </div>
        <div class="tiny" style="margin: -8px 0 14px; color: var(--ink-3)">
          「今日到期」= 到期日不晚于今天的卡片；导入后每次评分（认识/模糊/不认识）会按遗忘曲线安排它的下次到期日。
        </div>

        <table class="tbl">
          <thead><tr><th>#</th><th>正面（回忆）</th><th>背面（要点）</th><th>章节</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in preview.cards.slice(0, 5)" :key="i">
              <td>{{ i + 1 }}</td>
              <td>{{ c.front.slice(0, 40) }}{{ c.front.length > 40 ? '…' : '' }}</td>
              <td>{{ c.back.slice(0, 50) }}{{ c.back.length > 50 ? '…' : '' }}</td>
              <td class="tiny">{{ c.chapter || '—' }}<span v-if="c.difficulty === '重点'" class="tag red" style="margin-left: 4px">重</span></td>
            </tr>
          </tbody>
        </table>
        <div v-if="preview.cards.length > 5" class="tiny" style="margin-top: 6px">… 以及另外 {{ preview.cards.length - 5 }} 张</div>
        <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 14px">
          <button class="btn ghost" @click="cancelPreview">取消</button>
          <button class="btn" @click="confirmImport">确认导入</button>
        </div>
      </div>
    </template>

    <!-- ===== 复习计划 / 考前盘点 ===== -->
    <template v-else-if="view === 'plan'">
      <div class="page-head row between wrap">
        <div>
          <h1>复习计划</h1>
          <div class="sub">时段目标 + 考前盘点：要考的科目还差哪些内容</div>
        </div>
        <button class="btn ghost" @click="backToList">← 返回卡片组</button>
      </div>

      <!-- 时段计划 -->
      <div class="card" style="margin-bottom: 16px">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 4px">背诵目标</h3>
        <div class="tiny" style="margin-bottom: 14px">完成数 = 该时段内评过分的卡片（认识/模糊/不认识都算）</div>
        <div class="grid3">
          <div v-for="kind in ['day', 'week', 'month']" :key="kind" class="card" style="box-shadow: none; padding: 14px">
            <div class="row between" style="margin-bottom: 6px">
              <b>{{ plans[kind].label }}</b>
              <span class="tiny">{{ planProg[kind]?.done ?? 0 }} / {{ plans[kind].target }}</span>
            </div>
            <div class="bar" style="margin-bottom: 10px">
              <i :class="{ green: pctOf(planProg[kind]?.done || 0, plans[kind].target) >= 100 }"
                 :style="{ width: pctOf(planProg[kind]?.done || 0, plans[kind].target) + '%' }"></i>
            </div>
            <div class="row" style="gap: 8px; margin-bottom: 8px">
              <input class="input" style="width: 90px" type="number" min="1"
                :value="plans[kind].target" @change="updateTarget(kind, $event)" />
              <span class="tiny">张目标</span>
            </div>
            <select class="input" style="font-size: 13px" :value="plans[kind].deckId" @change="updatePlanDeck(kind, $event)">
              <option value="">全部卡片组</option>
              <option v-for="d in decks" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 考前盘点 -->
      <div class="card">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 4px">考前盘点</h3>
        <div class="tiny" style="margin-bottom: 14px">依据进度页的下个考期与报考科目，盘点卡片掌握差距</div>

        <div v-if="!readiness || !readiness.session" class="empty" style="padding: 20px">
          <p>还没有未来的考期。先到<a href="#/progress">进度页</a>添加考期并勾选报考科目</p>
        </div>

        <template v-else>
          <div class="card" style="padding: 14px; margin-bottom: 12px; background: var(--accent-weak); border-color: transparent; box-shadow: none">
            <div class="row between wrap">
              <div>
                <b>{{ readiness.session.name }}</b>
                <div class="tiny" style="margin-top: 2px">考试日 {{ readiness.session.examDate }}</div>
              </div>
              <div style="text-align: right">
                <div style="font-size: 28px; font-weight: 800; color: var(--accent)">{{ readiness.daysLeft }}<span style="font-size: 14px"> 天</span></div>
                <div class="tiny">距考试</div>
              </div>
            </div>
          </div>

          <div v-if="!readiness.subjects.length" class="tiny" style="padding: 8px 0">
            本期没有报考科目，或报考科目都已通过
          </div>

          <div v-for="rs in readiness.subjects" :key="rs.subject.id" style="margin-bottom: 14px">
            <div class="row" style="gap: 8px; margin-bottom: 8px">
              <b>{{ rs.subject.name }}</b>
              <span v-if="rs.noDeck" class="tag amber">未关联卡片组</span>
            </div>
            <div v-if="rs.noDeck" class="tiny">
              到卡片页给该科目的卡片组选择归属科目，即可在此盘点
            </div>
            <div v-for="dk in rs.decks" :key="dk.id" class="card" style="padding: 12px 14px; margin-bottom: 8px; box-shadow: none">
              <div class="row between" style="margin-bottom: 6px">
                <span style="font-size: 13px; font-weight: 600">{{ dk.name }}</span>
                <span class="tiny">掌握 <b style="color: var(--green)">{{ dk.mastered }}</b>/{{ dk.total }} · 今日到期 {{ dk.due }}</span>
              </div>
              <div class="bar" style="margin-bottom: 8px">
                <i :class="{ green: dk.total && dk.mastered === dk.total }"
                   :style="{ width: (dk.total ? Math.round((dk.mastered / dk.total) * 100) : 0) + '%' }"></i>
              </div>
              <div v-if="dk.weakChapters.length" class="row wrap" style="gap: 6px">
                <span class="tiny" style="width: 100%">还差的章节：</span>
                <span class="tag red" v-for="w in dk.weakChapters" :key="w.chapter">
                  {{ w.chapter }} {{ w.mastered }}/{{ w.total }}
                </span>
              </div>
              <div v-else class="tiny" style="color: var(--green)">全部章节已掌握 🎉</div>
            </div>
          </div>
        </template>
      </div>
    </template>

    <!-- ===== 卡片组列表 ===== -->
    <template v-else>
      <div class="page-head row between wrap">
        <div>
          <h1>知识卡片</h1>
          <div class="sub">从讲义摘知识点背诵打基础——题目类复习是练习页的「题卡复习」，两套体系互不相通</div>
        </div>
        <div class="row" style="gap: 8px">
          <button class="btn ghost" @click="openPlan">复习计划</button>
          <button class="btn ghost" :disabled="!!cardsTask" @click="aiInput.click()">AI 从讲义摘取</button>
          <button class="btn" :disabled="!!cardsTask" @click="directInput.click()">+ 导入卡片</button>
        </div>
        <input ref="aiInput" type="file" accept=".pdf,.docx,.txt,.md" style="display: none" @change="onAiFilePick" />
        <input ref="directInput" type="file" accept=".json,.xlsx,.xls,.csv,.txt,.md" style="display: none" @change="onDirectFilePick" />
      </div>

      <details class="card" style="margin-bottom: 14px; padding: 12px 16px">
        <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: var(--ink-2)">
          ⓘ 知识卡片怎么用？（点开看格式与说明）
        </summary>
        <div class="tiny" style="line-height: 1.9; margin-top: 10px; color: var(--ink-2)">
          ① <b>AI 从讲义摘取</b>：支持 PDF/Word/TXT 讲义，按章切分逐段提取「正面=回忆钩子，背面=背诵要点」的卡片；需先在<a href="#/settings">设置页</a>配置 AI；后台生成，进度球全程跟进；扫描版 PDF 不支持；<br />
          ② <b>直接导入</b>：JSON 格式 <code>{"deck":{"name":"组名"},"cards":[{"front":"正面","back":"背面","chapter":"章","difficulty":"重点"}]}</code>；Excel 表头含「正面/知识点」与「反面/内容」列；TXT 每行一条 <code>正面=&gt;反面</code>，<code># 章节名</code> 分组；<br />
          ③ <b>背诵</b>：每组可「背今天到期的」（间隔重复，答不认识明天再来）或「随机背 10 张」（有事没事背几条）；翻面后按 认识/模糊/不认识 评分，安排下次复习时间；<b>导入时可选新卡安排</b>——立即到期 / 每日投放 N 张 / 推迟 X 天开始，「今日到期」就是到期日不晚于今天的卡片数。
        </div>
      </details>

      <div v-if="needAiCfg" class="card" style="margin-bottom: 14px; border-color: var(--amber); background: var(--amber-weak)">
        <div class="row between wrap">
          <div>
            <b style="color: var(--amber)">尚未配置 AI 模型</b>
            <div class="tiny" style="margin-top: 2px">AI 摘取需要 OpenAI 兼容接口（DeepSeek / 通义 / Kimi / Ollama 均可），Key 只存本机。</div>
          </div>
          <router-link to="/settings"><button class="btn sm">去设置页配置</button></router-link>
        </div>
      </div>

      <!-- AI 后台任务进度（本页内联；离开后进度球跟进） -->
      <div v-if="cardsTask && (cardsTask.phase === 'extracting' || cardsTask.phase === 'generating')" class="card" style="margin-bottom: 14px; border-color: var(--accent)">
        <div class="row between" style="margin-bottom: 8px">
          <b>{{ cardsTask.phase === 'extracting' ? '正在提取文本…' : `AI 摘取中：${cardsTask.idx} / ${cardsTask.total} 段` }}</b>
          <button class="btn ghost sm" @click="cancelAiTask">取消</button>
        </div>
        <div class="tiny" style="margin-bottom: 8px">{{ cardsTask.title }}<template v-if="cardsTask.sectionTitle"> · {{ cardsTask.sectionTitle }}</template></div>
        <div class="bar">
          <i :style="{ width: (cardsTask.phase === 'extracting' ? 8 : cardsTask.total ? (cardsTask.idx / cardsTask.total) * 100 : 8) + '%' }"></i>
        </div>
        <div class="tiny" style="margin-top: 8px">已摘 {{ cardsTask.got }} 张 · 可离开本页，右下角进度球跟进</div>
      </div>

      <p v-if="studyMsg" class="card" style="padding: 10px 16px; color: var(--green); margin-bottom: 14px">{{ studyMsg }}</p>

      <!-- 按章节背：章节选择 -->
      <div v-if="pickerDeck" class="card" style="margin-bottom: 14px; border-color: var(--accent)">
        <div class="row between" style="margin-bottom: 10px">
          <b>按章节背：{{ pickerDeck.name }}</b>
          <button class="btn ghost sm" @click="closePicker">收起</button>
        </div>
        <div v-if="!pickerChapters.length" class="tiny">这个组还没有卡片</div>
        <div v-for="ch in pickerChapters" :key="ch.chapter" class="card" style="padding: 10px 14px; margin-bottom: 8px; box-shadow: none">
          <div class="row between wrap">
            <div>
              <span style="font-size: 13px; font-weight: 600">{{ ch.chapter }}</span>
              <span class="tiny" style="margin-left: 8px">
                共 {{ ch.total }} 张 · 到期 <b :style="{ color: ch.due ? 'var(--accent)' : '' }">{{ ch.due }}</b> · 掌握
                <b style="color: var(--green)">{{ ch.mastered }}</b>/{{ ch.total }}
              </span>
            </div>
            <div class="row" style="gap: 6px">
              <button class="btn sm" :disabled="!ch.due" @click="startStudy(pickerDeck, 'due', ch.chapter)">背到期（{{ ch.due }}）</button>
              <button class="btn ghost sm" @click="startStudy(pickerDeck, 'random', ch.chapter)">随机背</button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!decks.length && !cardsTask && !preview" class="card empty">
        <div class="big">❑</div>
        <p>还没有卡片组。用「AI 从讲义摘取」把 PDF/Word 变成背诵卡，<br />或「+ 导入卡片」用 JSON/Excel/TXT 直接导入</p>
      </div>

      <div v-else class="grid3">
        <div v-for="d in decks" :key="d.id" class="card">
          <div class="row between" style="margin-bottom: 4px">
            <b>{{ d.name }}</b>
            <button class="btn ghost sm" @click="delDeck(d)">删</button>
          </div>
          <div class="tiny" style="margin-bottom: 8px">{{ d.count }} 张 · 今日到期 <b :style="{ color: d.due ? 'var(--accent)' : '' }">{{ d.due }}</b> 张</div>
          <select class="input" style="font-size: 13px; margin-bottom: 10px" :value="d.subjectId || ''" @change="assignDeckSubject(d, $event)">
            <option value="">归属科目：不关联</option>
            <option v-for="s in subjects" :key="s.id" :value="s.id">归属科目：{{ s.name }}</option>
          </select>
          <div class="row wrap" style="gap: 8px">
            <button class="btn sm" :disabled="!d.due" @click="startStudy(d, 'due')">背今天到期（{{ d.due }}）</button>
            <button class="btn ghost sm" :disabled="!d.count" @click="startStudy(d, 'random')">随机 10 张</button>
            <button class="btn ghost sm" :disabled="!d.count" @click="openPicker(d)">按章节背</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kcard {
  perspective: 1200px;
  height: 260px;
  cursor: pointer;
}

.kcard-inner {
  position: relative;
  width: 100%;
  height: 100%;
  transition: transform 0.5s;
  transform-style: preserve-3d;
}

.kcard.flipped .kcard-inner {
  transform: rotateY(180deg);
}

.kface {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 28px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.kface.back {
  transform: rotateY(180deg);
  border-color: var(--accent);
}
</style>
