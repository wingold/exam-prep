/* 本机偏好设置
   放在 localStorage 而不是 db.meta：这些是「这台设备要不要这么用」的开关，
   不该跟着 WebDAV 同步到另一台设备，也不该进全量备份。 */

const KEY = 'exam_prefs'

const DEFAULTS = {
  /* 答错自动加入题卡复习队列。
     关掉后：答错只进错题本，不再自动排期；已存在的卡片不受影响，
     仍可在练习页手动「加入题卡复习」，也可继续用复习模式。 */
  autoEnroll: true,
  /* 按下按钮时轻震动一下。安卓 WebView 需要 VIBRATE 权限（已加），
     iOS / 桌面浏览器没有这个能力，调用会被静默忽略。 */
  haptic: true,
}

export function getPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式下写入失败时，本次会话仍按返回值生效 */
  }
  return next
}

export function getPref(key) {
  return getPrefs()[key]
}
