/* Cloudflare Worker — WebDAV 跨域代理（免费版足够个人使用）
 *
 * 部署步骤（约 3 分钟，无需付费）：
 * 1. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Worker
 * 2. 把本文件全部内容粘贴进编辑器 → Deploy
 * 3. 复制分配给你的地址（形如 https://webdav-proxy.xxx.workers.dev）
 * 4. 在应用「设置 → WebDAV 双端同步 → 跨域代理」里填这个地址
 *
 * 协议：GET/POST/PUT https://你的-worker/?u=<encodeURIComponent(目标URL)>
 * 仅转发请求，不存储任何数据；建议自行加上访问限制（见下方注释）。
 */

export default {
  async fetch(request) {
    // 可选：加上你自己的口令防止被他人滥用，取消下一行注释并改掉密码
    // if (new URL(request.url).searchParams.get('key') !== '你的口令') return new Response('forbidden', { status: 403 })

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const target = new URL(request.url).searchParams.get('u')
    if (!target || !/^https:\/\//.test(target)) {
      return new Response('missing ?u=', { status: 400, headers: cors })
    }

    const headers = new Headers()
    const auth = request.headers.get('Authorization')
    if (auth) headers.set('Authorization', auth)
    const ct = request.headers.get('Content-Type')
    if (ct) headers.set('Content-Type', ct)

    const init = { method: request.method, headers }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer()
    }

    const upstream = await fetch(target, init)
    const respHeaders = new Headers(cors)
    const ut = upstream.headers.get('Content-Type')
    if (ut) respHeaders.set('Content-Type', ut)
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
  },
}
