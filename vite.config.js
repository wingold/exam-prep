import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'

/* 版本号唯一来源：package.json。Android 的 versionName / versionCode 也读它，
   避免出现「APK 已发到 v1.6.1、build.gradle 还写 1.0」这种漂移。 */
const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))

/* WebDAV 同源代理：坚果云等网盘不返回 CORS 头，浏览器直连必失败。
   把 /dav-sync?u=<目标URL> 转发到目标（服务端发起，无跨域限制）。
   dev（npm run dev）和 preview（npm run preview）都要挂，否则 preview 端口下同步必报跨域。
   注意：必须手工跟随重定向并保留 Authorization —— undici fetch 在跨域重定向时
   会丢弃 Authorization 头，导致坚果云对 PUT 返回 404。 */
function webdavProxy() {
  const mount = (server) => {
    const LOG = path.join(process.cwd(), 'proxy-debug.log')
    const log = (line) => {
      try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n') } catch { /* ignore */ }
    }
    server.middlewares.use('/dav-sync', async (req, res) => {
      try {
        const u = new URL(req.url, 'http://localhost').searchParams.get('u')
        if (!u || !/^https?:\/\//.test(u)) {
          res.statusCode = 400
          return res.end('missing or invalid ?u=')
        }
        const headers = {}
        if (req.headers.authorization) headers.authorization = req.headers.authorization
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']

        let body
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = await new Promise((resolve, reject) => {
            const chunks = []
            req.on('data', (c) => chunks.push(c))
            req.on('end', () => resolve(Buffer.concat(chunks)))
            req.on('error', reject)
          })
        }

        // 手工跟随重定向（最多 5 次），全程保留 Authorization
        let target = u
        let r = null
        for (let hop = 0; hop < 5; hop++) {
          const t0 = Date.now()
          r = await fetch(target, { method: req.method, headers, body, redirect: 'manual' })
          log(`${req.method} ${target} -> ${r.status} (${Date.now() - t0}ms) body=${body ? body.length : 0}B`)
          if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
            const loc = r.headers.get('location')
            target = new URL(loc, target).toString()
            log(`  redirect -> ${target}`)
            // 303 按规范改为 GET；301/302 对 PUT 也保守改为 GET（与浏览器一致），但保留头
            if (r.status === 303 || ((r.status === 301 || r.status === 302) && req.method !== 'GET' && req.method !== 'HEAD')) {
              log(`  method rewritten to GET per ${r.status}`)
              req.method = 'GET'
              body = undefined
            }
            continue
          }
          break
        }

        res.statusCode = r.status
        const skip = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'])
        r.headers.forEach((v, k) => {
          if (!skip.has(k.toLowerCase())) res.setHeader(k, v)
        })
        res.setHeader('Access-Control-Allow-Origin', '*')
        const buf = Buffer.from(await r.arrayBuffer())
        if (r.status >= 400) {
          log(`  upstream error body: ${buf.toString('utf8').slice(0, 300)}`)
        }
        res.setHeader('Content-Length', buf.length)
        res.end(buf)
      } catch (e) {
        log(`proxy error: ${e && e.message ? e.message : String(e)}`)
        res.statusCode = 502
        res.end('proxy error: ' + (e && e.message ? e.message : String(e)))
      }
    })
  }

  return {
    name: 'webdav-proxy',
    configureServer: mount,
    // preview 走的是构建产物，中间件不会自动继承 configureServer，必须单独挂
    configurePreviewServer: mount,
  }
}

export default defineConfig({
  plugins: [vue(), webdavProxy()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: { host: true, port: 5174, strictPort: true },
  /* preview 也用 5174：origin 由 协议+域名+端口 决定，
     换端口等于换一个「站点」，IndexedDB / localStorage 全都是空的。
     统一端口后 dev 与 preview 共用同一份本地数据，配置也不用重填。
     strictPort：端口被占时直接报错，而不是悄悄退到 5175 —— 换端口就是换 origin，
     会表现为「数据全没了、又要重新配置」。 */
  preview: { host: true, port: 5174, strictPort: true },
})
