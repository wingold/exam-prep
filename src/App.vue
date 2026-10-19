<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { syncReady, runSync } from './sync'
import { refreshExamCap } from './srs'
import FloatingBall from './components/FloatingBall.vue'

const route = useRoute()
const router = useRouter()

const footText = ref('本地存储 · 数据自持')
const moreOpen = ref(false)
let timer = null
let firstTimer = null

/* 底部导航：4 个主入口 + 更多（防止拥挤）；桌面侧栏仍显示全部 */
const PRIMARY = ['/', '/practice', '/cards', '/wrong']
const primaryRoutes = computed(() =>
  PRIMARY.map((p) => router.options.routes.find((r) => r.path === p)).filter(Boolean)
)
const moreRoutes = computed(() => router.options.routes.filter((r) => !PRIMARY.includes(r.path)))

watch(() => route.path, () => { moreOpen.value = false })

async function autoSync() {
  if (!syncReady()) return
  try {
    footText.value = '同步中…'
    const action = await runSync()
    // 同步可能带来新的考期，刷新间隔封顶
    await refreshExamCap()
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
  // 间隔封顶要用到最近考期，启动时先读一次
  try { await refreshExamCap() } catch { /* 无考期表也不影响使用 */ }
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

    <!-- 更多菜单遮罩（仅手机端可见） -->
    <div v-if="moreOpen" class="more-mask" @click="moreOpen = false"></div>

    <nav class="bottomnav">
      <router-link
        v-for="r in primaryRoutes"
        :key="r.path"
        :to="r.path"
        :class="{ on: $route.path === r.path }"
      >
        <span class="ico">{{ r.meta.ico }}</span>
        {{ r.meta.title }}
      </router-link>
      <a
        class="more-btn"
        :class="{ on: moreOpen || moreRoutes.some((r) => r.path === $route.path) }"
        @click="moreOpen = !moreOpen"
      >
        <span class="ico">☰</span>
        更多
      </a>
    </nav>

    <!-- 更多菜单面板 -->
    <div v-if="moreOpen" class="more-panel">
      <router-link v-for="r in moreRoutes" :key="r.path" :to="r.path" class="more-item">
        <span class="ico">{{ r.meta.ico }}</span>
        {{ r.meta.title }}
      </router-link>
    </div>

    <!-- AI 后台任务悬浮进度球（全站可见） -->
    <FloatingBall />
  </div>
</template>
