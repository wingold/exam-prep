<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { syncReady, runSync } from './sync'
import FloatingBall from './components/FloatingBall.vue'

const footText = ref('本地存储 · 数据自持')
let timer = null
let firstTimer = null

async function autoSync() {
  if (!syncReady()) return
  try {
    footText.value = '同步中…'
    const action = await runSync()
    const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    footText.value = action === '已是最新' ? `已同步 ${t}` : `已同步 ${t} · ${action}`
  } catch (e) {
    // 静默失败，不打断使用；设置页有详细错误
    footText.value = '本地存储 · 数据自持'
  }
}

onMounted(async () => {
  // 安卓：内容排布在状态栏下方，避免标题与时间/电量重叠；
  // iOS 保持沉浸（由 CSS env(safe-area-inset-top) 处理）
  if (Capacitor.getPlatform() === 'android') {
    try {
      await StatusBar.setOverlaysWebView({ overlay: false })
      await StatusBar.setStyle({ style: Style.Light })
    } catch { /* 个别机型失败时退回 CSS 安全区兜底 */ }
  }
  // 启动 2.5 秒后自动静默同步（等首屏可交互），之后每 30 分钟一次
  firstTimer = setTimeout(autoSync, 2500)
  timer = setInterval(autoSync, 30 * 60 * 1000)
})

onUnmounted(() => {
  clearTimeout(firstTimer)
  clearInterval(timer)
})
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="logo">考证<span>刷题</span></div>
      <router-link
        v-for="r in $router.options.routes"
        :key="r.path"
        :to="r.path"
        class="nav"
        :class="{ on: $route.path === r.path }"
      >
        <span>{{ r.meta.ico }}</span> {{ r.meta.title }}
      </router-link>
      <div class="spacer"></div>
      <div class="foot">{{ footText }}</div>
    </aside>

    <main class="main">
      <router-view />
    </main>

    <nav class="bottomnav">
      <router-link
        v-for="r in $router.options.routes.filter((x) => x.path !== '/settings')"
        :key="r.path"
        :to="r.path"
        :class="{ on: $route.path === r.path }"
      >
        <span class="ico">{{ r.meta.ico }}</span>
        {{ r.meta.title }}
      </router-link>
    </nav>

    <!-- AI 后台任务悬浮进度球（全站可见） -->
    <FloatingBall />
  </div>
</template>
