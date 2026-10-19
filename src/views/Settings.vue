<script setup>
import { ref, computed, onMounted } from 'vue'
import { Capacitor } from '@capacitor/core'
import { exportAll, importAll } from '../db'
import { getAIConfig, setAIConfig } from '../ai'
import { getWebdavConfig, setWebdavConfig, runSync, validateDavUrl, testConnection } from '../sync'

const isNative = Capacitor.isNativePlatform()
// 由 vite define 注入，取自 package.json（与 Android versionName 同源）
const appVersion = __APP_VERSION__

const file = ref(null)
const msg = ref('')
const err = ref('')
const stats = ref(null)
const ai = ref({ baseUrl: '', apiKey: '', model: '' })
const aiSaved = ref(false)
const wd = ref({ url: '', user: '', pass: '', proxy: '' })
const syncing = ref(false)
const syncMsg = ref('')
const syncErr = ref('')
const testing = ref(false)
const testMsg = ref('')
const testOk = ref(null)

const urlHint = computed(() => validateDavUrl(wd.value.url))
const formReady = computed(() => !!(wd.value.url.trim() && wd.value.user.trim() && wd.value.pass.trim()) && !urlHint.value)
const proxyShown = computed(() => {
  if (isNative) return '当前为手机 APK：走原生网络直连，无需代理，此项留空即可'
  const custom = (wd.value.proxy || '').trim()
  return custom || (import.meta.env.DEV ? '/dav-sync（开发服务器内置代理，自动生效）' : '未配置')
})

async function copyVersion() {
  const text = `考证刷题 v${appVersion} · ${isNative ? 'Android APK' : '网页版'} · ${navigator.userAgent}`
  try {
    await navigator.clipboard.writeText(text)
    msg.value = '版本信息已复制'
  } catch {
    msg.value = text
  }
  setTimeout(() => { msg.value = '' }, 2500)
}

onMounted(async () => {
  const d = await exportAll()
  stats.value = {
    banks: d.banks.length,
    questions: d.questions.length,
    attempts: d.attempts.length,
    wrong: d.wrongItems.length,
  }
  ai.value = getAIConfig()
  wd.value = getWebdavConfig()
})

function saveAI() {
  setAIConfig({
    baseUrl: ai.value.baseUrl.trim(),
    apiKey: ai.value.apiKey.trim(),
    model: ai.value.model.trim(),
  })
  aiSaved.value = true
  setTimeout(() => (aiSaved.value = false), 2000)
}

function saveWd() {
  setWebdavConfig({
    url: wd.value.url.trim(),
    user: wd.value.user.trim(),
    pass: wd.value.pass.trim(),
    proxy: wd.value.proxy.trim(),
  })
}

function fillJgySandbox() {
  wd.value.url = 'https://dav.jianguoyun.com/dav/'
}

async function doSync() {
  saveWd()
  syncing.value = true
  syncMsg.value = ''
  syncErr.value = ''
  try {
    const action = await runSync()
    syncMsg.value = '同步完成：' + action
  } catch (e) {
    syncErr.value = e.message
  } finally {
    syncing.value = false
  }
}

async function doTest() {
  saveWd()
  testing.value = true
  testMsg.value = ''
  testOk.value = null
  try {
    const r = await testConnection()
    testOk.value = r.ok
    testMsg.value = r.message
  } finally {
    testing.value = false
  }
}

function fillJgyRoot() {
  wd.value.url = 'https://dav.jianguoyun.com/dav/'
}

async function doExport() {
  const d = await exportAll()
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `exam-prep-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

async function doImport(ev, mode) {
  const f = (ev.target.files && ev.target.files[0]) || file.value
  if (!f) return
  err.value = ''
  msg.value = ''
  try {
    const data = JSON.parse(await f.text())
    if (mode === 'replace' && !confirm('覆盖导入会清空当前所有数据，确定吗？')) return
    await importAll(data, { mode })
    msg.value = '导入成功，正在刷新…'
    setTimeout(() => location.reload(), 800)
  } catch (e) {
    err.value = '导入失败：' + e.message
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>设置</h1>
      <div class="sub">数据全部存在本机浏览器中，请定期导出备份</div>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px">当前数据</h3>
      <div class="grid4" v-if="stats">
        <div><div class="tiny">题库</div><div style="font-size: 22px; font-weight: 700">{{ stats.banks }}</div></div>
        <div><div class="tiny">题目</div><div style="font-size: 22px; font-weight: 700">{{ stats.questions }}</div></div>
        <div><div class="tiny">作答记录</div><div style="font-size: 22px; font-weight: 700">{{ stats.attempts }}</div></div>
        <div><div class="tiny">错题</div><div style="font-size: 22px; font-weight: 700">{{ stats.wrong }}</div></div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 6px">导出备份</h3>
      <p class="muted" style="margin-bottom: 12px">导出为 JSON 文件，可在任意设备导入恢复。</p>
      <button class="btn" @click="doExport">导出全部数据</button>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 6px">导入备份</h3>
      <p class="muted" style="margin-bottom: 12px">
        <b>覆盖导入</b>清空当前数据后恢复；<b>合并导入</b>保留现有数据。
      </p>
      <div class="row wrap">
        <input type="file" accept=".json" @change="doImport($event, 'merge')" />
      </div>
      <div class="row wrap" style="margin-top: 10px">
        <button class="btn ghost sm" @click="$refs.rep.click()">覆盖导入…</button>
        <input ref="rep" type="file" accept=".json" style="display: none" @change="doImport($event, 'replace')" />
      </div>
      <p v-if="msg" style="color: var(--green); font-size: 13px; margin-top: 10px">{{ msg }}</p>
      <p v-if="err" style="color: var(--red); font-size: 13px; margin-top: 10px">{{ err }}</p>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 6px">WebDAV 双端同步</h3>
      <p class="muted" style="margin-bottom: 12px">
        手机与电脑指向同一网盘目录即可互通，同步文件为 <code>exam-prep-sync.json</code>。
      </p>

      <!-- 坚果云三步指引 -->
      <div class="card" style="padding: 12px 14px; background: var(--amber-weak); border-color: transparent; margin-bottom: 14px">
        <div class="tiny" style="line-height: 1.8; color: var(--ink-2)">
          <b style="color: var(--amber)">坚果云用户必看（三步）：</b><br />
          ① 地址填<b>根目录</b>最稳（sandbox 是开发者区域，常报 409）：
          <button class="btn ghost sm" style="margin-left: 4px" @click="fillJgySandbox">一键填入根目录</button>
          文件会放在网盘根目录；想单独放，先在网页版建好文件夹再改地址<br />
          ② 密码必须是<b>应用密码</b>：坚果云网页版 → 头像 → 账户信息 → 安全选项 → 生成应用密码（不是登录密码）<br />
          ③ 填好后先点<b>「测试连接」</b>，成功再点「立即同步」{{ isNative ? '（手机 APK 直连网盘，无需代理）' : '' }}
        </div>
      </div>

      <label class="field">
        <span class="lab">WebDAV 目录地址</span>
        <input class="input" v-model="wd.url" placeholder="https://dav.jianguoyun.com/dav/sandbox/" />
        <span v-if="urlHint" class="tiny" style="color: var(--red); display: block; margin-top: 4px">{{ urlHint }}</span>
      </label>
      <div class="grid2">
        <label class="field">
          <span class="lab">账号</span>
          <input class="input" v-model="wd.user" autocomplete="off" />
        </label>
        <label class="field">
          <span class="lab">应用密码</span>
          <input class="input" type="password" v-model="wd.pass" autocomplete="new-password" />
        </label>
      </div>
      <label class="field">
        <span class="lab">跨域代理（一般不用改）</span>
        <input class="input" v-model="wd.proxy" placeholder="留空自动使用；或填 Cloudflare Worker 地址" />
        <span class="tiny" style="display: block; margin-top: 4px">
          当前生效：{{ proxyShown }}。部署到静态网站后需自建 Worker（项目根目录 cloudflare-worker.js，附部署说明）。
        </span>
      </label>
      <div class="row" style="gap: 10px">
        <button class="btn" :disabled="syncing || !formReady" @click="doSync">
          {{ syncing ? '同步中…' : '立即同步' }}
        </button>
        <button class="btn ghost" :disabled="testing || !formReady" @click="doTest">
          {{ testing ? '检测中…' : '测试连接' }}
        </button>
        <button class="btn ghost" @click="saveWd">保存连接</button>
      </div>
      <p v-if="testMsg" :style="{ color: testOk ? 'var(--green)' : 'var(--red)', fontSize: '13px', marginTop: '10px', whiteSpace: 'pre-wrap' }">{{ testMsg }}</p>
      <p v-if="syncMsg" style="color: var(--green); font-size: 13px; margin-top: 10px">{{ syncMsg }}</p>
      <p v-if="syncErr" style="color: var(--red); font-size: 13px; margin-top: 10px">{{ syncErr }}</p>
      <p class="tiny" style="margin-top: 10px">合并规则：记录级「谁新用谁」，不会覆盖更新的本地记录。</p>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 6px">AI 讲题（可选）</h3>
      <p class="muted" style="margin-bottom: 12px">
        接你自己的 OpenAI 兼容接口（DeepSeek / 通义 / Kimi / Ollama 本地等）。Key 只存本机，不进同步备份。
        <b>答题页的「AI 讲题」、统计页的「AI 针对薄弱出题」、题库页的「PDF 讲义 AI 出题」都依赖这份配置。</b>
      </p>
      <label class="field">
        <span class="lab">Base URL（含 /v1）</span>
        <input class="input" v-model="ai.baseUrl" placeholder="https://api.deepseek.com/v1" />
      </label>
      <label class="field">
        <span class="lab">API Key</span>
        <input class="input" type="password" v-model="ai.apiKey" placeholder="sk-…" />
      </label>
      <label class="field">
        <span class="lab">模型名</span>
        <input class="input" v-model="ai.model" placeholder="deepseek-chat" />
      </label>
      <button class="btn" @click="saveAI">{{ aiSaved ? '已保存 ✓' : '保存配置' }}</button>
    </div>

    <div class="card">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 6px">关于</h3>
      <p class="muted">考证刷题助手 v{{ appVersion }} · 本地存储，无账号无埋点</p>
      <p class="tiny" style="margin-top: 6px">支持：题库导入 / 多模式练习 / 模考 / 错题本 / 题卡复习 / 知识卡片 / 成绩统计 / AI 讲题 / WebDAV 同步</p>
      <button class="btn ghost sm" style="margin-top: 10px" @click="copyVersion">复制版本信息</button>
    </div>
  </div>
</template>
