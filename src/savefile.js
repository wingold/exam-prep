import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/* 保存文本为文件。
   为什么不能只用 <a download>：Android WebView（Capacitor 壳）不实现 HTML 的下载行为，
   点下去既不报错也不产生文件，表现就是"按了没反应"。所以手机上必须走原生文件写入。

   手机的落点与取回方式：
   1. 写进应用缓存目录（无需任何权限，Android 11+ 也能写）；
   2. 立刻调系统分享面板，由用户选「保存到文件（下载）」「发送给微信」「存到网盘」等。
   分享面板关闭后文件会被系统回收，所以不在面板里选一次就等于没保存——这一点要在界面上说清。 */

export const isNative = () => Capacitor.isNativePlatform()

export async function saveTextFile(filename, text, { mime = 'application/json' } = {}) {
  const size = new Blob([text]).size
  const kb = Math.max(1, Math.round(size / 1024))

  if (!isNative()) {
    // 浏览器：保持原生下载，另外给一个明确的落点说明（各浏览器不同，无法拿到真实路径）
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return { where: 'browser', path: filename, filename, kb, shared: false }
  }

  const res = await Filesystem.writeFile({
    path: filename,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  })

  let shared = false
  let cancel = false
  try {
    await Share.share({
      title: filename,
      url: res.uri,
      dialogTitle: `保存或发送 ${filename}`,
    })
    shared = true
  } catch (e) {
    // 用户关掉分享面板会抛错，这不是失败，不能报"导出失败"
    const m = (e && (e.message || e.errorMessage)) || ''
    cancel = /cancel/i.test(m) || !m
  }

  return { where: 'native', path: res.uri, filename, kb, shared, cancel }
}

/* 再次打开分享面板（用户第一次误关时不用重新导出一遍） */
export async function shareSavedFile(path, filename) {
  await Share.share({
    title: filename,
    url: path,
    dialogTitle: `保存或发送 ${filename}`,
  })
}
