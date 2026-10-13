<script setup>
import { ref, computed, watch } from 'vue'
import { streamExplain, aiReady } from '../ai'
import { mdToHtml } from '../markdown'

const props = defineProps({
  question: { type: Object, required: true },
  chosen: { type: Array, default: () => [] },
})

const text = ref('')
const loading = ref(false)
const err = ref('')
const show = ref(false)
const needCfg = ref(false)

const html = computed(() => mdToHtml(text.value))

// 换题时重置
watch(
  () => props.question?.id,
  () => {
    show.value = false
    text.value = ''
    err.value = ''
    loading.value = false
  }
)

async function ask() {
  if (!aiReady()) {
    needCfg.value = true
    return
  }
  needCfg.value = false
  show.value = true
  if (text.value) return
  loading.value = true
  err.value = ''
  try {
    await streamExplain({ question: props.question, chosen: props.chosen }, (t) => {
      text.value += t
    })
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div>
    <button v-if="!show" class="btn ghost sm" :disabled="loading" @click="ask">
      {{ aiReady() ? 'AI 讲题' : 'AI 讲题（未配置）' }}
    </button>
    <div v-if="needCfg" class="card" style="margin-top: 8px; padding: 10px 14px; border-color: var(--amber); background: var(--amber-weak)">
      <div class="row between wrap">
        <span class="tiny" style="color: var(--ink-2)">讲题需要 AI 模型：到设置页填 Base URL / API Key / 模型名（Key 只存本机）</span>
        <router-link to="/settings"><button class="btn sm">去配置</button></router-link>
      </div>
    </div>
    <div v-else-if="show" class="card" style="margin-top: 10px; border-color: var(--accent)">
      <div class="row between" style="margin-bottom: 6px">
        <span class="tag accent">AI 讲解</span>
        <button v-if="!loading" class="btn ghost sm" @click="text = ''; ask()">重新生成</button>
      </div>
      <p v-if="err" style="color: var(--red); font-size: 13px">{{ err }}</p>
      <p v-else-if="loading && !text" class="muted">正在生成…</p>
      <div v-if="text" class="ai-md" v-html="html"></div>
      <div v-if="loading && text" class="tiny" style="margin-top: 6px">生成中…</div>
      <div class="tiny" style="margin-top: 8px">由你配置的模型生成，仅供辅助参考</div>
    </div>
  </div>
</template>

<style scoped>
.ai-md {
  font-size: 14px;
  line-height: 1.7;
  color: var(--ink);
}
.ai-md :deep(p) { margin: 0 0 8px; }
.ai-md :deep(p:last-child) { margin-bottom: 0; }
.ai-md :deep(h3),
.ai-md :deep(h4),
.ai-md :deep(h5),
.ai-md :deep(h6) {
  font-size: 14px;
  font-weight: 700;
  margin: 12px 0 6px;
}
.ai-md :deep(ul),
.ai-md :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}
.ai-md :deep(li) { margin: 2px 0; }
.ai-md :deep(strong) { font-weight: 700; color: var(--ink); }
.ai-md :deep(code) {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 13px;
}
.ai-md :deep(pre) {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 0 0 8px;
}
.ai-md :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
}
</style>
