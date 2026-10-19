<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { aiStore, cancelTask, dismissTask } from '../aistore'
import Icon from './Icon.vue'

const router = useRouter()
const pos = ref({ x: 0, y: 0 })
const panelOpen = ref(false)
const panelPos = ref({ left: 0, top: 0 })
let drag = null // { sx, sy, ox, oy, moved }

const task = computed(() => aiStore.task)

const pct = computed(() => {
  const t = task.value
  if (!t) return 0
  if (t.phase === 'extracting') return 10
  if (t.phase === 'done') return 100
  if (t.phase === 'error') return 100
  if (!t.total) return 12
  return Math.max(8, Math.min(97, Math.round((t.idx / t.total) * 100)))
})

const ballLabel = computed(() => {
  const t = task.value
  if (!t) return ''
  if (t.phase === 'extracting') return '…'
  if (t.phase === 'done') return '✓'
  if (t.phase === 'error') return '!'
  if (t.phase === 'cancelled') return '✓'
  return t.total > 1 ? `${t.idx}/${t.total}` : '…'
})

const ringStyle = computed(() => {
  const t = task.value
  const color = t && (t.phase === 'done' || (t.phase === 'cancelled' && t.got)) ? 'var(--green)'
    : t && t.phase === 'error' ? 'var(--red)' : 'var(--accent)'
  return { background: `conic-gradient(${color} ${pct.value}%, #e6e8ee 0)` }
})

const phaseText = computed(() => {
  const t = task.value
  if (!t) return ''
  if (t.phase === 'extracting') return '正在提取文本…'
  if (t.phase === 'generating') return `AI 生成中 ${t.idx}/${t.total} 段`
  if (t.phase === 'done') return t.kind === 'pdf' ? '题目生成完成！' : t.kind === 'cards' ? '卡片摘取完成！' : '已生成专项题库！'
  if (t.phase === 'error') return '生成失败'
  if (t.phase === 'cancelled') return t.got ? '已取消（保留部分结果）' : '已取消'
  return ''
})

/* 完成/失败时自动弹出面板提醒（用户若正拖着看也无妨） */
watch(() => task.value && task.value.phase, (p) => {
  if (p === 'done' || p === 'error') {
    panelOpen.value = true
    layoutPanel()
    try { navigator.vibrate && navigator.vibrate(180) } catch { /* ignore */ }
  }
})

/* 无任务时收起面板 */
watch(task, (t) => {
  if (!t) panelOpen.value = false
})

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

function layoutPanel() {
  const W = 300
  const H = 210
  const left = clamp(pos.value.x + 28 - W / 2, 10, window.innerWidth - W - 10)
  let top = pos.value.y - H - 14
  if (top < 10) top = pos.value.y + 70 // 球太靠上则面板放下方
  panelPos.value = { left, top }
}

function onDown(e) {
  e.preventDefault()
  drag = { sx: e.clientX, sy: e.clientY, ox: pos.value.x, oy: pos.value.y, moved: false }
  e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId)
}

function onMove(e) {
  if (!drag) return
  const dx = e.clientX - drag.sx
  const dy = e.clientY - drag.sy
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) drag.moved = true
  pos.value = {
    x: clamp(drag.ox + dx, 8, window.innerWidth - 64),
    y: clamp(drag.oy + dy, 8, window.innerHeight - 64),
  }
  if (panelOpen.value) layoutPanel()
}

function onUp() {
  if (drag && !drag.moved) {
    panelOpen.value = !panelOpen.value
    if (panelOpen.value) layoutPanel()
  }
  drag = null
}

function savePos() {
  try { localStorage.setItem('ai_ball_pos', JSON.stringify(pos.value)) } catch { /* ignore */ }
}

function viewResult() {
  const t = task.value
  if (!t || t.phase !== 'done' || !t.result) return
  // 不在此处标记 consumed —— 由目标页面读取结果后自行标记
  panelOpen.value = false
  if (t.kind === 'pdf') {
    router.push('/banks') // Banks 挂载时消费 result → 预览
  } else if (t.kind === 'cards') {
    router.push('/cards') // Cards 挂载时消费 result → 预览
  } else {
    router.push('/practice?bank=' + t.result.bankId)
  }
}

function closeBall() {
  dismissTask()
  panelOpen.value = false
}

onMounted(() => {
  let saved = null
  try { saved = JSON.parse(localStorage.getItem('ai_ball_pos')) } catch { /* ignore */ }
  pos.value = saved && typeof saved.x === 'number'
    ? { x: clamp(saved.x, 8, window.innerWidth - 64), y: clamp(saved.y, 8, window.innerHeight - 64) }
    : { x: window.innerWidth - 84, y: window.innerHeight - 150 }
  window.addEventListener('pointerup', () => savePos())
})
</script>

<template>
  <div v-if="task" class="ball-root" :style="{ left: pos.x + 'px', top: pos.y + 'px' }">
    <!-- 展开面板 -->
    <div
      v-if="panelOpen"
      class="ball-panel"
      :style="{ left: panelPos.left + 'px', top: panelPos.top + 'px' }"
    >
      <div class="row between" style="margin-bottom: 8px">
        <span class="tag" :class="task.phase === 'done' ? 'green' : task.phase === 'error' ? 'red' : 'accent'">
          {{ phaseText }}
        </span>
        <button class="btn ghost sm" style="padding: 2px 8px" @click="panelOpen = false">收起</button>
      </div>
      <div style="font-size: 13px; font-weight: 600; margin-bottom: 6px; word-break: break-all">{{ task.title }}</div>
      <template v-if="task.phase === 'generating' || task.phase === 'extracting'">
        <div class="bar" style="margin-bottom: 6px"><i :style="{ width: pct + '%' }"></i></div>
        <div class="tiny">
          {{ task.phase === 'extracting' ? '提取文本中…' : `第 ${task.idx}/${task.total} 段：${task.sectionTitle}` }}
          <template v-if="task.got"> · 已得 {{ task.got }} 题</template>
        </div>
        <div class="tiny" style="margin-top: 4px">可离开任意页面，生成在后台继续</div>
        <button class="btn ghost sm" style="margin-top: 10px" @click="cancelTask">取消生成</button>
      </template>
      <template v-else-if="task.phase === 'done'">
        <div class="tiny" style="margin-bottom: 8px">
          共 {{ task.result?.questions?.length ?? task.got }} 题
          <template v-if="task.result?.warnings?.length"> · {{ task.result.warnings.length }} 段失败</template>
          <template v-if="task.result?.cancelledPartial"> · （已取消，为部分结果）</template>
        </div>
        <div class="row" style="gap: 8px">
          <button class="btn sm" @click="viewResult">查看结果</button>
          <button class="btn ghost sm" @click="closeBall">知道了</button>
        </div>
      </template>
      <template v-else-if="task.phase === 'error'">
        <div class="tiny" style="color: var(--red); margin-bottom: 8px; white-space: pre-wrap">{{ task.error }}</div>
        <button class="btn ghost sm" @click="closeBall">关闭</button>
      </template>
      <template v-else>
        <div class="tiny" style="margin-bottom: 8px">已取消{{ task.got ? `，已生成 ${task.got} 题` : '' }}</div>
        <div class="row" style="gap: 8px">
          <button v-if="task.got && task.result" class="btn sm" @click="viewResult">查看结果</button>
          <button class="btn ghost sm" @click="closeBall">关闭</button>
        </div>
      </template>
    </div>

    <!-- 球体 -->
    <button
      class="ball"
      :style="ringStyle"
      title="AI 生成任务"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
    >
      <span class="ball-inner" :class="{ pulse: task.phase === 'generating' || task.phase === 'extracting' }">
        <Icon
          v-if="task.phase === 'done' || (task.phase === 'cancelled' && task.got)"
          name="check"
          :size="22"
          :stroke="2.4"
        />
        <Icon v-else-if="task.phase === 'error'" name="alert" :size="20" :stroke="2.2" />
        <template v-else>{{ ballLabel }}</template>
      </span>
    </button>
  </div>
</template>

<style scoped>
.ball-root {
  position: fixed;
  z-index: 300;
  width: 56px;
  height: 56px;
  touch-action: none;
}

.ball {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  padding: 5px;
  cursor: grab;
  box-shadow: 0 4px 16px rgba(27, 31, 42, 0.25);
  transition: transform 0.15s;
}

.ball:active { cursor: grabbing; }
.ball:hover { transform: scale(1.06); }
/* 拖拽/按下都要有明确的体积变化，否则手指压在球上没有任何回应 */
.ball.is-pressing,
.ball:active { transform: scale(0.93); transition-duration: 0.08s; }

.ball-inner {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #fff;
  font-size: 14px;
  font-weight: 800;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.ball-inner.pulse { animation: pulse 1.4s ease-in-out infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.ball-panel {
  position: fixed;
  width: 300px;
  max-width: calc(100vw - 20px);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(27, 31, 42, 0.18);
  padding: 14px;
  z-index: 301;
}
</style>
