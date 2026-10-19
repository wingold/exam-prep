<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import mammoth from 'mammoth/mammoth.browser'
import * as XLSX from 'xlsx'
import db, { uid, now, plain, getOrCreateCert, listSubjects, exportBank } from '../db'
import { parseJson, parseText, parseSheetRows } from '../importers'
import { aiReady } from '../ai'
import { aiStore, startPdfTask } from '../aistore'
import { saveTextFile } from '../savefile'
import ExportNotice from '../components/ExportNotice.vue'

const banks = ref([])
const subjects = ref([])
const questionCount = ref({})
const bankSubject = ref({}) // bankId -> subjectId map（题库列表用）
const importing = ref(false)
const importMsg = ref('')
const importErr = ref('')
const exporting = ref('') // 正在导出的题库 id，防重复点击
const exportInfo = ref(null) // { filename, kb, path, where, shared, cancel, count, name }
const preview = ref(null) // { bankName, questions, fileName, targetSubjectId }
const fileInput = ref(null)
const pdfInput = ref(null)
const needAiCfg = ref(false)

/* 全局 AI 任务（PDF 出题）实时镜像：页面内也能看进度，进度球则全站可见 */
const pdfTask = computed(() => (aiStore.task && aiStore.task.kind === 'pdf' ? aiStore.task : null))

onMounted(async () => {
  consumePdfResult()
  const cert = await getOrCreateCert()
  subjects.value = await listSubjects(cert.id)
  await reload()
})

// 停在本页等待时，任务完成也要立即进入预览（监听 phase 字符串，对象原地变更不触发引用比较）
watch(() => pdfTask.value && pdfTask.value.phase, (p) => {
  if (p === 'done') consumePdfResult()
})

function consumePdfResult() {
  const t = aiStore.task
  if (t && t.kind === 'pdf' && (t.phase === 'done' || (t.phase === 'cancelled' && t.got)) && t.result && !t.consumed) {
    preview.value = { ...t.result, targetSubjectId: '' }
    t.consumed = true
  }
}

async function reload() {
  banks.value = await db.banks.orderBy('createdAt').reverse().toArray()
  questionCount.value = {}
  for (const b of banks.value) {
    questionCount.value[b.id] = await db.questions.where('bankId').equals(b.id).count()
  }
}

/* ---------- 导入 ---------- */

async function onFile(ev) {
  const f = ev.target.files?.[0]
  if (!f) return
  importErr.value = ''
  importMsg.value = ''
  importing.value = true
  preview.value = null
  try {
    let result
    const name = f.name.toLowerCase()
    if (name.endsWith('.json')) {
      result = parseJson(await f.text())
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      result = parseSheetRows(rows)
    } else if (name.endsWith('.docx')) {
      const buf = await f.arrayBuffer()
      const { value } = await mammoth.extractRawText({ arrayBuffer: buf })
      result = parseText(value)
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      result = parseText(await f.text())
    } else {
      throw new Error('暂不支持该格式（支持 .json .xlsx .xls .csv .docx .txt）')
    }
    if (!result.questions.length) throw new Error('未解析出任何题目，请检查文件格式')
    result.fileName = f.name
    if (!result.bankName) result.bankName = f.name.replace(/\.[^.]+$/, '')
    preview.value = result
  } catch (e) {
    importErr.value = '导入失败：' + e.message
  } finally {
    importing.value = false
    ev.target.value = ''
  }
}

async function confirmImport() {
  if (!preview.value) return
  const p = preview.value
  const bankId = uid()
  await db.banks.put({
    id: bankId,
    subjectId: p.targetSubjectId || null,
    name: p.bankName || '未命名题库',
    source: p.fileName,
    createdAt: now(),
  })
  const qs = plain(p.questions).map((q, i) => ({ id: uid(), bankId, seq: i + 1, ...q }))
  await db.questions.bulkPut(qs)
  importMsg.value = `已导入 ${qs.length} 题到「${p.bankName}」`
  preview.value = null
  await reload()
}

function cancelImport() {
  preview.value = null
}

async function delBank(b) {
  if (!confirm(`删除题库「${b.name}」及其 ${questionCount.value[b.id] || 0} 道题目？作答记录保留。`)) return
  await db.questions.where('bankId').equals(b.id).delete()
  await db.banks.delete(b.id)
  await reload()
}

async function assignSubject(b, ev) {
  await db.banks.update(b.id, { subjectId: ev.target.value || null })
}

/* 单题库导出：格式与导入一致，导出的文件可直接再导入。
   手机上不能用 <a download>（Android WebView 静默无效），统一交给 savefile.js 走原生。 */
async function exportBankFile(b) {
  importMsg.value = ''
  importErr.value = ''
  if (exporting.value) return
  exporting.value = b.id
  try {
    const data = await exportBank(b.id)
    if (!data.questions.length) throw new Error('该题库没有题目可导出')
    const filename = `${safeFileName(b.name)}.json`
    const r = await saveTextFile(filename, JSON.stringify(data, null, 2))
    exportInfo.value = { ...r, count: data.questions.length, name: b.name }
    if (r.where === 'browser') {
      importMsg.value = `已导出「${b.name}」共 ${data.questions.length} 题（${r.kb} KB），请到浏览器的下载目录查看`
    } else if (r.shared) {
      importMsg.value = `已导出「${b.name}」共 ${data.questions.length} 题（${r.kb} KB），已交给系统分享面板`
    } else {
      importMsg.value = `已生成「${b.name}」共 ${data.questions.length} 题（${r.kb} KB），但分享面板被关掉了——文件还没存到手机上`
    }
  } catch (e) {
    importErr.value = '导出失败：' + (e.message || e)
  } finally {
    exporting.value = ''
  }
}

/* 第一次误关分享面板时，不用重新导出一遍（由 ExportNotice 组件内部处理） */

function safeFileName(s) {
  return String(s || '题库').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
}

function chapters(p) {
  const set = new Set(p.questions.map((q) => q.chapter).filter(Boolean))
  return [...set]
}

function keyCount(p) {
  return p.questions.filter((q) => q.difficulty === '重点').length
}

/* ---------- PDF 讲义 → AI 出题（后台任务，进度见悬浮球/本页卡片） ---------- */

function onPdfPick(ev) {
  const f = ev.target.files?.[0]
  if (!f) return
  ev.target.value = ''
  if (!aiReady()) {
    needAiCfg.value = true
    return
  }
  needAiCfg.value = false
  importErr.value = ''
  importMsg.value = ''
  preview.value = null
  // 后台运行：可离开本页，进度球全站可见
  startPdfTask(f)
}

function cancelPdf() {
  if (aiStore.task) aiStore.task.cancelled = true
}
</script>

<template>
  <div>
    <div class="page-head row between wrap">
      <div>
        <h1>题库</h1>
        <div class="sub">导入 Word / Excel / JSON / 文本题库；PDF 讲义可 AI 出题；单个题库可导出 JSON</div>
      </div>
      <div class="row" style="gap: 8px">
        <button class="btn ghost" :disabled="importing || !!pdfTask" @click="pdfInput.click()">
          PDF 讲义 AI 出题
        </button>
        <button class="btn" @click="fileInput.click()" :disabled="importing || !!pdfTask">
          {{ importing ? '解析中…' : '+ 导入题库' }}
        </button>
      </div>
      <input ref="fileInput" type="file" accept=".json,.xlsx,.xls,.csv,.docx,.txt,.md" style="display: none" @change="onFile" />
      <input ref="pdfInput" type="file" accept=".pdf" style="display: none" @change="onPdfPick" />
    </div>

    <!-- PDF 出题使用说明 -->
    <details class="card" style="margin-bottom: 14px; padding: 12px 16px">
      <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: var(--ink-2)">
        ⓘ PDF 讲义 AI 出题怎么用？（点开看注意事项）
      </summary>
      <div class="tiny" style="line-height: 1.9; margin-top: 10px; color: var(--ink-2)">
        ① <b>前置条件</b>：先到<a href="#/settings">设置页</a>配置 AI 模型接口（AI 讲题、弱项出卷、PDF 出题共用这份配置）；<br />
        ② <b>PDF 必须带文字层</b>——在阅读器里能选中复制文字的那种。扫描版/图片版 PDF 提不出文字，暂不支持（无 OCR）；可先转成 Word 或纯文本再用「导入题库」；<br />
        ③ <b>出题方式</b>：自动按「第x章/专题」切章，逐章把知识点改编成题（约每 700 字 1 题，核心考点标"重点"），每章约半分钟，章多的讲义需要几分钟；<b>生成在后台进行，可随时离开本页</b>——右下角会出现可拖动的进度球，点球看详情，完成后球会提醒你去查看结果；可随时取消（已生成的保留）；<br />
        ④ <b>预览确认</b>：全部生成后进入预览，核对无误再点「确认导入」才会入库；个别章节失败会汇总提示，不影响其他章节。
      </div>
    </details>

    <!-- AI 未配置提示 -->
    <div v-if="needAiCfg" class="card" style="margin-bottom: 14px; border-color: var(--amber); background: var(--amber-weak)">
      <div class="row between wrap">
        <div>
          <b style="color: var(--amber)">尚未配置 AI 模型</b>
          <div class="tiny" style="margin-top: 2px">PDF 出题需要一个 OpenAI 兼容接口（DeepSeek / 通义 / Kimi / Ollama 均可），Key 只存本机。</div>
        </div>
        <router-link to="/settings"><button class="btn sm">去设置页配置</button></router-link>
      </div>
    </div>

    <!-- PDF 出题进度（本页内联；离开页面后右下角进度球继续显示） -->
    <div v-if="pdfTask && (pdfTask.phase === 'extracting' || pdfTask.phase === 'generating')" class="card" style="margin-bottom: 16px; border-color: var(--accent)">
      <div class="row between" style="margin-bottom: 8px">
        <b>{{ pdfTask.phase === 'extracting' ? '正在提取 PDF 文本…' : `AI 出题中：${pdfTask.idx} / ${pdfTask.total} 段` }}</b>
        <button v-if="pdfTask.phase === 'generating' || pdfTask.phase === 'extracting'" class="btn ghost sm" @click="cancelPdf">取消</button>
      </div>
      <div class="tiny" style="margin-bottom: 8px">{{ pdfTask.title }}<template v-if="pdfTask.sectionTitle"> · 当前：{{ pdfTask.sectionTitle }}</template></div>
      <div class="bar">
        <i :style="{ width: (pdfTask.phase === 'extracting' ? 8 : pdfTask.total ? (pdfTask.idx / pdfTask.total) * 100 : 8) + '%' }"></i>
      </div>
      <div class="tiny" style="margin-top: 8px">
        已生成 {{ pdfTask.got }} 题 · 可离开本页，右下角进度球全程跟进；完成后点球查看
      </div>
    </div>

    <p v-if="importMsg" class="card" style="padding: 10px 16px; color: var(--green); margin-bottom: 12px">{{ importMsg }}</p>
    <p v-if="importErr" class="card" style="padding: 10px 16px; color: var(--red); margin-bottom: 12px">{{ importErr }}</p>

    <!-- 导出落点说明：手机上 <a download> 无效，必须让用户看到文件到底在哪、有没有真存下来 -->
    <ExportNotice :info="exportInfo" />

    <!-- 导入预览 -->
    <div v-if="preview" class="card" style="margin-bottom: 16px; border-color: var(--accent)">
      <div class="row between wrap" style="margin-bottom: 10px">
        <div>
          <b>预览：{{ preview.bankName }}</b>
          <span class="muted" style="margin-left: 8px">解析出 {{ preview.questions.length }} 题</span>
          <span v-if="keyCount(preview)" class="tag red" style="margin-left: 8px">重点 {{ keyCount(preview) }}</span>
          <span v-if="chapters(preview).length" class="tiny" style="margin-left: 8px">
            章节：{{ chapters(preview).join('、') }}
          </span>
        </div>
      </div>
      <div v-if="preview.warnings?.length" class="tiny" style="color: var(--amber); margin-bottom: 8px; white-space: pre-wrap">
        ⚠ {{ preview.warnings.length }} 段生成失败：{{ preview.warnings[0] }}{{ preview.warnings.length > 1 ? ' 等' : '' }}
      </div>
      <div class="row wrap" style="margin-bottom: 10px">
        <span class="tiny">归属科目：</span>
        <select class="input" style="width: auto" v-model="preview.targetSubjectId">
          <option value="">不关联</option>
          <option v-for="s in subjects" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </div>
      <table class="tbl">
        <thead><tr><th>#</th><th>题干</th><th>题型</th><th>答案</th></tr></thead>
        <tbody>
          <tr v-for="(q, i) in preview.questions.slice(0, 5)" :key="i">
            <td>{{ i + 1 }}</td>
            <td>{{ q.stem.slice(0, 60) }}{{ q.stem.length > 60 ? '…' : '' }}</td>
            <td>{{ { single: '单选', multi: '多选', judge: '判断', fill: '填空', essay: '简答' }[q.type] }}</td>
            <td>{{ q.answer.join(',') }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="preview.questions.length > 5" class="tiny" style="margin-top: 6px">… 以及另外 {{ preview.questions.length - 5 }} 题</div>
      <div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 14px">
        <button class="btn ghost" @click="cancelImport">取消</button>
        <button class="btn" @click="confirmImport">确认导入</button>
      </div>
    </div>

    <!-- 题库列表 -->
    <div v-if="!banks.length && !preview" class="card empty">
      <div class="big">▤</div>
      <p>还没有题库。点击右上角「导入题库」开始<br />支持格式见 PRD：Excel 表头需含 题干/选项A/答案；文本格式见示例</p>
      <button class="btn" @click="fileInput.click()">导入题库</button>
    </div>

    <div v-else class="grid3">
      <div v-for="b in banks" :key="b.id" class="card">
        <div class="row between" style="margin-bottom: 6px">
          <b>{{ b.name }}</b>
          <div class="row" style="gap: 4px">
            <button class="btn ghost sm" :disabled="!!exporting" @click="exportBankFile(b)">
              {{ exporting === b.id ? '导出中…' : '导出' }}
            </button>
            <button class="btn ghost sm" @click="delBank(b)">删</button>
          </div>
        </div>
        <div class="tiny" style="margin-bottom: 8px">{{ questionCount[b.id] || 0 }} 题 · 来源 {{ b.source || '—' }}</div>
        <select class="input" style="font-size: 13px" :value="b.subjectId || ''" @change="assignSubject(b, $event)">
          <option value="">不关联科目</option>
          <option v-for="s in subjects" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <div class="row" style="gap: 6px; margin-top: 10px">
          <router-link :to="{ path: '/practice', query: { bank: b.id } }"><button class="btn sm">练习</button></router-link>
          <router-link :to="{ path: '/exam', query: { bank: b.id } }"><button class="btn ghost sm">考试</button></router-link>
        </div>
      </div>
    </div>
  </div>
</template>
