/* WebDAV 同步：经同源/Worker 代理转发（坚果云不返回 CORS 头，浏览器直连必失败）
   代理协议：GET/PUT <proxyBase>?u=<encodeURIComponent(目标URL)>，其余透传
   dev：同源 /dav-sync（vite 中间件）；生产：Cloudflare Worker（见 cloudflare-worker.js）
   合并策略：记录级 updatedAt last-write-wins */

import { Capacitor, CapacitorHttp } from '@capacitor/core'
import db, { exportAll, importAll, now } from './db'

const LS_KEY = 'webdav_config'
const FILE = 'exam-prep-sync.json'
const TABLES = [
  'certificates', 'subjects', 'sessions', 'registrations', 'scores',
  'banks', 'questions', 'attempts', 'papers', 'results', 'wrongItems', 'cards',
]

export function getWebdavConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_KEY)) || {}
    return { url: '', user: '', pass: '', proxy: '', ...c }
  } catch {
    return { url: '', user: '', pass: '', proxy: '' }
  }
}

export function setWebdavConfig(cfg) {
  const old = getWebdavConfig()
  localStorage.setItem(LS_KEY, JSON.stringify({ ...old, ...cfg }))
}

export function syncReady() {
  const c = getWebdavConfig()
  return !!(c.url && c.user && c.pass)
}

/* URL 校验：拦截网页版地址等常见填错 */
export function validateDavUrl(url) {
  const u = (url || '').trim()
  if (!u) return null
  if (/jianguoyun\.com\/#\/|www\.jianguoyun\.com/i.test(u)) {
    return '这是坚果云「网页版」地址，不能用于同步。WebDAV 地址应为 https://dav.jianguoyun.com/dav/ 开头（sandbox 目录填 https://dav.jianguoyun.com/dav/sandbox/）。'
  }
  if (!/^https?:\/\//i.test(u)) {
    return '地址需以 https:// 开头'
  }
  return null
}

/* 当前生效的代理基址 */
export function activeProxyBase() {
  const c = getWebdavConfig()
  const custom = (c.proxy || '').trim().replace(/\/+$/, '')
  if (custom) return custom
  // dev 用 vite 同源代理；其他环境留空 → 直连（会失败，但保留逃生通道）
  if (import.meta.env.DEV) return '/dav-sync'
  return ''
}

function authHeader(c) {
  // 复制应用密码时常带首尾空格/换行，先修剪再编码
  const user = String(c.user || '').trim()
  const pass = String(c.pass || '').trim()
  return 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass}`)))
}

function fileUrl(c) {
  // 注意：WebDAV 路径不能拼查询串（?_= 会让坚果云返回 400），缓存靠 fetch 的 cache:no-store 控制
  const base = c.url.trim().replace(/\/+$/, '')
  return base + '/' + FILE
}

/* 请求 WebDAV：APK 走原生网络层（无 CORS、无需代理）；Web 走代理/直连 */
async function davFetch(targetUrl, c, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase()

  // ---- 原生（APK）：显式调用 CapacitorHttp，彻底绕开 WebView 的跨域限制 ----
  if (Capacitor.isNativePlatform()) {
    let res
    try {
      res = await CapacitorHttp.request({
        url: targetUrl,
        method,
        headers: { Authorization: authHeader(c), ...(opts.headers || {}) },
        data: method === 'GET' || method === 'HEAD' ? undefined : opts.body,
        connectTimeout: 20000,
        readTimeout: 90000,
      })
    } catch (e) {
      throw new Error(
        '手机网络请求失败：' + (e.message || String(e)) +
        '。请确认手机能上网、WebDAV 地址正确（与电脑端一致）。此错误与跨域无关，APK 无需配置代理。'
      )
    }
    // CapacitorHttp 对 4xx/5xx 也返回响应对象（不抛异常），包装成 fetch 风格
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => {
        if (res.data == null || res.data === '') return null
        if (typeof res.data === 'string') return JSON.parse(res.data || 'null')
        return res.data
      },
      text: async () => {
        if (res.data == null) return ''
        return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      },
    }
  }

  // ---- Web：代理或直连 ----
  const proxy = activeProxyBase()
  const finalUrl = proxy
    ? proxy + (proxy.includes('?') ? '&' : '?') + 'u=' + encodeURIComponent(targetUrl)
    : targetUrl
  try {
    return await fetch(finalUrl, {
      method,
      headers: { Authorization: authHeader(c), ...(opts.headers || {}) },
      body: opts.body,
      cache: 'no-store',
    })
  } catch (e) {
    const hint = proxy
      ? '代理请求失败，请确认代理服务可用。'
      : '浏览器直连 WebDAV 被跨域(CORS)拦截。请在下方「跨域代理」填 Worker 地址；在本开发服务器上使用可留空（自动走内置代理）。'
    throw new Error('网络或跨域(CORS)失败：' + hint)
  }
}

async function fetchRemote(c) {
  const res = await davFetch(fileUrl(c), c)
  if (res.status === 404) return null
  if (res.status === 401) throw new Error('认证失败(401)：请检查账号，且密码必须是坚果云「应用密码」（网页版→头像→账户信息→安全选项→生成应用密码），不是登录密码。复制时请去掉首尾空格。')
  if (res.status === 409) throw new Error('HTTP 409：这个目录在网盘里不存在。请先把地址改成根目录 https://dav.jianguoyun.com/dav/ 试试；或在坚果云网页版里先创建好文件夹再填对应地址。')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`下载失败：HTTP ${res.status}${body ? '｜服务器返回：' + body.slice(0, 200) : ''}`)
  }
  return res.json()
}

async function uploadRemote(c, envelope) {
  const res = await davFetch(fileUrl(c), c, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  if (res.status === 401) throw new Error('认证失败(401)：请使用坚果云「应用密码」而非登录密码。')
  if (res.status === 409) throw new Error('HTTP 409：目标目录不存在，无法写入。请把地址改为根目录 https://dav.jianguoyun.com/dav/，或先在网页版创建文件夹。')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`上传失败：HTTP ${res.status}${body ? '｜服务器返回：' + body.slice(0, 200) : ''}`)
  }
}

/* 连接自检：PROPFIND 列目录 + 试写探针，一次性定位「能读不能写」这类问题 */
export async function testConnection() {
  if (!syncReady()) return { ok: false, message: '请先填写目录地址、账号和应用密码' }
  const c = getWebdavConfig()
  const urlErr = validateDavUrl(c.url)
  if (urlErr) return { ok: false, message: urlErr }

  const base = c.url.trim().replace(/\/+$/, '') + '/'
  let res
  try {
    // 1) 列目录（Depth:1），看清真实结构
    res = await davFetch(base, c, { method: 'PROPFIND', headers: { Depth: '1' } })
  } catch (e) {
    return { ok: false, message: e.message }
  }

  if (res.status === 401) return { ok: false, message: '认证失败(401)：账号或密码不对。必须使用「应用密码」（网页版→头像→账户信息→安全选项→生成），不是登录密码；注意复制时不要带空格。' }
  if (res.status === 404) return { ok: false, message: '目录不存在(404)：建议改用根目录 https://dav.jianguoyun.com/dav/。' }
  if (res.status === 409) return { ok: false, message: '目录不存在(409)：请改用根目录 https://dav.jianguoyun.com/dav/，或先在网页版建好文件夹。' }
  if (!(res.status === 207 || res.status === 200)) {
    return { ok: false, message: '目录检测失败：HTTP ' + res.status }
  }

  const xml = await res.text().catch(() => '')
  const hrefs = [...xml.matchAll(/<[^>]*href[^>]*>([^<]+)<\//gi)]
    .map((m) => { try { return decodeURIComponent(m[1]) } catch { return m[1] } })
    .filter((h) => h && !h.endsWith('/..'))
  const listing = [...new Set(hrefs)].slice(0, 15)

  // 2) 写探针：PUT 一个小文件，再删掉
  const probeUrl = base + '.exam-prep-probe.tmp'
  let putStatus = 0
  let putBody = ''
  try {
    const putRes = await davFetch(probeUrl, c, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'probe',
    })
    putStatus = putRes.status
    if (!putRes.ok) putBody = (await putRes.text().catch(() => '')).slice(0, 150)
    // 尽力清理探针文件
    await davFetch(probeUrl, c, { method: 'DELETE' }).catch(() => {})
  } catch (e) {
    return { ok: false, message: '写探针请求失败：' + e.message }
  }

  const listText = listing.length ? listing.map((h) => '  ' + h).join('\n') : '  （空目录）'
  if (putStatus >= 200 && putStatus < 300) {
    return { ok: true, message: `连接成功，可正常读写。目录内容：\n${listText}` }
  }
  return {
    ok: false,
    message:
      `账号密码有效，但此目录【不能写入】(PUT HTTP ${putStatus}${putBody ? '：' + putBody : ''})。\n` +
      `目录内容：\n${listText}\n` +
      `请把上面列出的某个文件夹路径填入地址栏（以 / 结尾）再试。`,
  }
}

/* 记录级合并：返回合并后的完整表数据 */
function mergeTable(localArr, remoteArr) {
  const map = new Map()
  for (const r of localArr) map.set(r.id, r)
  for (const r of remoteArr) {
    const l = map.get(r.id)
    if (!l) {
      map.set(r.id, r)
      continue
    }
    const lt = l.updatedAt || l.at || l.createdAt || 0
    const rt = r.updatedAt || r.at || r.createdAt || 0
    if (rt > lt) map.set(r.id, r)
  }
  return [...map.values()]
}

/* 执行同步：下载 → 合并 → 写回本地 → 上传 */
let inFlight = false
export function syncInFlight() { return inFlight }

export async function runSync() {
  if (inFlight) throw new Error('同步进行中，请稍候')
  if (!syncReady()) throw new Error('请先填写 WebDAV 地址与账号')
  const c = getWebdavConfig()
  const urlErr = validateDavUrl(c.url)
  if (urlErr) throw new Error(urlErr)

  inFlight = true
  try {
    const local = await exportAll()
    const remote = await fetchRemote(c)

    let merged = local
    let action = '上传'

    if (remote && remote.version === 1) {
      merged = { ...local, version: 1, exportedAt: new Date().toISOString() }
      let changed = 0
      for (const t of TABLES) {
        const before = new Map((local[t] || []).map((r) => [r.id, r]))
        const m = mergeTable(local[t] || [], remote[t] || [])
        merged[t] = m
        for (const r of m) if (!before.has(r.id)) changed++
      }
      action = changed ? `拉取合并（+${changed} 条新记录）` : '已是最新'

      if (changed) {
        await importAll(merged, { mode: 'merge' })
      }
    }

    merged.exportedAt = new Date().toISOString()
    merged.syncedAt = now()
    await uploadRemote(c, merged)
    return action
  } finally {
    inFlight = false
  }
}
