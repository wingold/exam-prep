<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { syncReady, runSync, getSyncStatus, SYNC_STALE_DAYS, flushScheduledSync } from './sync'
import { refreshExamCap } from './srs'
import FloatingBall from './components/FloatingBall.vue'
import Icon from './components/Icon.vue'

const route = useRoute()
const router = useRouter()

const footText = ref('本地存储 · 数据自持')
const moreOpen = ref(false)
let timer = null
let firstTimer = null
let tickTimer = null

/* 同步状态常驻展示：配置了就一定要能看见「上次什么时候成功的」，
   否则自动同步静默失败时，用户会一直以为云端是最新的。 */
const syncConfigured = ref(syncReady())
const syncState = ref(getSyncStatus())
const nowTick = ref(Date.now())

const syncLine = computed(() => {
  if (!syncConfigured.value) return ''
  const st = syncState.value
  void nowTick.value // 依赖时间，跨天/跨小时后文案会自己更新
  if (!st) return '尚未同步'
  if (st.ok === false) return '同步失败 · 见设置'
  if (!st.at) return '尚未同步'
  const days = Math.floor((nowTick.value - st.at) / 86400e3)
  if (days >= 1) return `${days} 天前同步`
  return '已同步 ' + new Date(st.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
})

const syncWarn = computed(() => {
  if (!syncConfigured.value) return false
  const st = syncState.value
  if (!st || !st.at) return true // 配了却从未成功过
  if (st.ok === false) return true
  return nowTick.value - st.at >= SYNC_STALE_DAYS * 86400e3
})

function refreshSyncState() {
  syncConfigured.value = syncReady()
  syncState.value = getSyncStatus()
  nowTick.value = Date.now()
}

/* 底部导航：4 个主入口 + 更多（防止拥挤）；桌面侧栏仍显示全部 */
const PRIMARY = ['/', '/practice', '/cards', '/wrong']
const primaryRoutes = computed(() =>
  PRIMARY.map((p) => router.options.routes.find((r) => r.path === p)).filter(Boolean)
)
const moreRoutes = computed(() => router.options.routes.filter((r) => !PRIMARY.includes(r.path)))

watch(() => route.path, () => {
  moreOpen.value = false
  // 从设置页改完配置回来，状态行要立刻反映
  refreshSyncState()
})

async function autoSync() {
  if (!syncReady()) return
  try {
    footText.value = '同步中…'
    const action = await runSync()
    // 同步可能带来新的考期，刷新间隔封顶
    await refreshExamCap()
    refreshSyncState()
    footText.value = action === '已是最新' ? '同步完成' : `同步完成 · ${action}`
    // 稳定态交回常驻状态行，避免两处文案重复
    setTimeout(() => { footText.value = '本地存储 · 数据自持' }, 4000)
  } catch (e) {
    // 不打断使用，但状态行会明确显示「同步失败 · 见设置」
    refreshSyncState()
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
  refreshSyncState()
  firstTimer = setTimeout(autoSync, 2500)
  timer = setInterval(autoSync, 30 * 60 * 1000)
  // 「N 天前同步」需要随时间推进而更新
  tickTimer = setInterval(refreshSyncState, 60 * 1000)
  // 切到后台/被系统回收前，把还在等待的延迟同步立刻补上
  document.addEventListener('visibilitychange', onVisibilityChange)
})

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    flushScheduledSync()
  } else {
    refreshSyncState()
  }
}

onUnmounted(() => {
  clearTimeout(firstTimer)
  clearInterval(timer)
  clearInterval(tickTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
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
        <Icon :name="r.meta.icon" :size="18" /> {{ r.meta.title }}
      </router-link>
      <div class="spacer"></div>
      <div class="foot" :class="{ warn: syncWarn }">
        {{ footText }}<template v-if="syncLine"> · {{ syncLine }}</template>
      </div>
    </aside>

    <main class="main">
      <router-view v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </router-view>
    </main>

    <nav class="bottomnav">
      <router-link
        v-for="r in primaryRoutes"
        :key="r.path"
        :to="r.path"
        :class="{ on: $route.path === r.path }"
      >
        <Icon :name="r.meta.icon" :size="21" />
        {{ r.meta.title }}
      </router-link>
      <a
        class="more-btn"
        :class="{ on: moreOpen || moreRoutes.some((r) => r.path === $route.path) }"
        @click="moreOpen = !moreOpen"
      >
        <Icon name="grid" :size="21" />
        更多
      </a>
    </nav>

    <!-- 更多菜单：遮罩与面板包一层，才能整体做升起动画 -->
    <Transition name="sheet">
      <div v-if="moreOpen" class="more-shell">
        <div class="more-mask" @click="moreOpen = false"></div>
        <div class="more-panel">
          <router-link v-for="r in moreRoutes" :key="r.path" :to="r.path" class="more-item">
            <Icon :name="r.meta.icon" :size="20" />
            {{ r.meta.title }}
          </router-link>
          <!-- 手机端侧栏不可见，同步状态在这里补一次，点进去就是设置页 -->
          <router-link v-if="syncLine" to="/settings" class="more-item more-sync" :class="{ warn: syncWarn }">
            <Icon name="sync" :size="15" />
            {{ syncLine }}
          </router-link>
        </div>
      </div>
    </Transition>

    <!-- AI 后台任务悬浮进度球（全站可见） -->
    <FloatingBall />
  </div>
</template>
