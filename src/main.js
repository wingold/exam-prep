import { createApp } from 'vue'
import { Capacitor } from '@capacitor/core'
import App from './App.vue'
import router from './router'
import { installPressFeedback } from './ui'
import './style.css'

createApp(App).use(router).mount('#app')

/* 全站按下反馈（水波 + 缩放 + 轻震动），一次安装，所有按钮生效 */
installPressFeedback()

/* 网页版注册 Service Worker 以获得离线能力。
   - APK 内不注册：Capacitor 的资源本来就在本地，多一层缓存只会在升级后
     继续返回旧界面，没有收益。
   - 开发模式不注册：否则改代码看不到效果，得手动清缓存。
   - 失败时静默降级：没有离线能力不影响在线使用。 */
const canPwa = 'serviceWorker' in navigator && import.meta.env.PROD && !Capacitor.isNativePlatform()
if (canPwa) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* http 非 localhost 环境浏览器本身就不允许注册，忽略即可 */
    })
  })
}
