/* 校验 Web 产物与 Android 内嵌资源是否一致
   背景：`npx cap sync android` 偶发失败（文件被 Gradle/杀毒占用），但 `gradlew assembleRelease`
   依然会 BUILD SUCCESSFUL —— 于是打出一个「界面还是上一版」的包，而且没有任何报错。
   出包前跑这一条，能立刻发现。

   用法：node scripts/verify-apk-assets.mjs */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const assetDir = path.join(root, 'android/app/src/main/assets/public')

function walk(dir, base = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? path.join(base, e.name) : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

if (!fs.existsSync(distDir)) {
  console.error('✗ 找不到 dist/，先跑 npm run build')
  process.exit(1)
}
if (!fs.existsSync(assetDir)) {
  console.error('✗ 找不到 android/app/src/main/assets/public，先跑 npx cap sync android')
  process.exit(1)
}

const distFiles = new Set(walk(distDir))
const assetFiles = new Set(walk(assetDir))

let bad = 0
for (const f of distFiles) {
  if (!assetFiles.has(f)) {
    console.log(`✗ Android 工程缺少：${f}`)
    bad++
    continue
  }
  const a = hash(path.join(distDir, f))
  const b = hash(path.join(assetDir, f))
  if (a !== b) {
    console.log(`✗ 内容不一致：${f}`)
    bad++
  }
}

// Android 侧多出来的文件只可能是 cap sync 生成物，不视为错误，但要提示
const extra = [...assetFiles].filter((f) => !distFiles.has(f))

if (bad) {
  console.log(`\n✗ ${bad} 个文件不一致 —— 重新执行 npx cap sync android 后再打包`)
  console.log('  注意：资源没同步上去时 gradle 仍然会 BUILD SUCCESSFUL，别只看 gradle 的结果。')
  process.exit(1)
}

console.log(`✓ Web 产物与 Android 内嵌资源一致（${distFiles.size} 个文件）`)
if (extra.length) console.log(`  Android 侧另有 ${extra.length} 个生成文件：${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ' …' : ''}`)
