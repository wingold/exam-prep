/* 全站按下反馈：水波 + 按压缩放 + 轻震动
   为什么用全局委托而不是给每个按钮加指令：
   现有视图里有几十个按钮，逐个改既容易漏、也会把模板弄脏。
   一次 pointerdown 委托，任何 button / 链接 / .tap 元素都能立刻获得反馈。 */

import { getPref } from './prefs'

const HOST_SEL = [
  'button',
  '.btn',
  'a.nav',
  '.bottomnav a',
  '.more-item',
  '.more-btn',
  '.tab',
  '.tap',
  '[data-press]',
].join(',')

let reduced = false
let installed = false

function vibrate(ms) {
  if (!getPref('haptic')) return
  try { navigator.vibrate && navigator.vibrate(ms) } catch { /* 不支持就算了 */ }
}

function spawnRipple(el, x, y) {
  if (reduced) return
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return
  const size = Math.max(r.width, r.height) * 2.1
  const ink = document.createElement('span')
  ink.className = 'press-ink'
  ink.style.width = ink.style.height = size + 'px'
  ink.style.left = x - r.left - size / 2 + 'px'
  ink.style.top = y - r.top - size / 2 + 'px'
  el.appendChild(ink)
  ink.addEventListener('animationend', () => ink.remove(), { once: true })
  // 兜底：动画被系统打断时也不会留下孤儿节点
  setTimeout(() => ink.remove(), 700)
}

function onDown(e) {
  if (e.button !== undefined && e.button !== 0) return
  const el = e.target.closest && e.target.closest(HOST_SEL)
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return

  if (!el.classList.contains('press-host')) {
    el.classList.add('press-host')
  }
  el.classList.add('is-pressing')
  spawnRipple(el, e.clientX, e.clientY)

  // 轻震动：只给「真的会改状态」的控件，链接滚动不震
  if (el.matches('button, .btn, .bottomnav a, .more-item, .more-btn, .sw')) {
    vibrate(el.matches('.btn') ? 8 : 5)
  }

  const clear = () => {
    el.classList.remove('is-pressing')
    window.removeEventListener('pointerup', clear)
    window.removeEventListener('pointercancel', clear)
  }
  window.addEventListener('pointerup', clear, { once: true })
  window.addEventListener('pointercancel', clear, { once: true })
}

export function installPressFeedback() {
  if (installed) return
  installed = true
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch { /* 老 WebView 没有 matchMedia */ }
  document.addEventListener('pointerdown', onDown, { passive: true })
}

/* 供 js 逻辑触发的一次性震动（例如答题判定、导出成功） */
export function tapFeedback(kind) {
  vibrate(kind === 'error' ? 30 : kind === 'success' ? 14 : 8)
}
