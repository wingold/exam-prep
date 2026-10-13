// 极简 WebDAV mock：支持 PUT/GET exam-prep-sync.json，Basic 认证 test:test
const http = require('http')
const fs = require('fs')
const path = require('path')
const FILE = path.join(__dirname, 'mock-dav', 'exam-prep-sync.json')
fs.mkdirSync(path.dirname(FILE), { recursive: true })

const server = http.createServer((req, res) => {
  // 模拟 CORS（预检不带 Authorization，先于鉴权放行）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const auth = 'Basic ' + Buffer.from('test:test').toString('base64')
  if (req.headers.authorization !== auth) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' })
    return res.end('unauthorized')
  }
  if (req.method === 'PUT') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      fs.writeFileSync(FILE, body)
      res.writeHead(204)
      res.end()
      console.log('PUT ok', body.length, 'bytes')
    })
  } else if (req.method === 'PROPFIND') {
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
    res.end('<?xml version="1.0" encoding="utf-8"?><multistatus xmlns="DAV:"><response><href>/exam-prep-sync.json</href></response></multistatus>')
  } else if (req.method === 'GET') {
    if (!fs.existsSync(FILE)) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(fs.readFileSync(FILE))
  } else {
    res.writeHead(405)
    res.end()
  }
})
server.listen(19110, '127.0.0.1', () => console.log('mock webdav on 19110'))
