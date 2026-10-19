/* 考证刷题 Service Worker（只对网页版生效，APK 里不注册）
   目标：断网也能打开应用、继续刷题与复习。

   策略分两类：
   - 导航请求（index.html）：network-first。发版后立刻拿到新外壳；
     离线时才回缓存。反过来（缓存优先）会让用户长期停在旧版本，
     而旧 index.html 引用的哈希资源在新部署里已经不存在，直接白屏。
   - 静态资源（/assets/*.js|css，文件名带哈希）：cache-first，命中即返回。

   跨域请求（WebDAV 同步、AI 接口）一律不经过缓存，
   避免把同步数据、请求头写进 Cache Storage。 */

const CACHE = 'exam-prep-shell-v1.8.0' // 发版时同步修改，activate 会清掉旧缓存
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './icon-192.png',
  './favicon-32.png',
  './apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // 单个文件失败不应该让整个 SW 装不上（比如某个图标被删了）
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  // 跨域：同步 / AI / CDN，交给网络自己处理
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('/sw.js')) return

  // 导航：网络优先，离线回落到缓存的外壳
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      try {
        const res = await fetch(req)
        if (res && res.ok) await cache.put('./index.html', res.clone())
        return res
      } catch {
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error()
      }
    })())
    return
  }

  // 静态资源：缓存优先，未命中再联网并写回
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(req)
    if (hit) return hit
    const res = await fetch(req)
    if (res && res.ok && res.type === 'basic') {
      try { await cache.put(req, res.clone()) } catch { /* 配额满时忽略 */ }
    }
    return res
  })())
})
