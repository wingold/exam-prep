<script setup>
import { ref } from 'vue'
import { shareSavedFile } from '../savefile'

/* 导出结果卡片：说明文件落在哪里、有没有真正保存成功。
   手机上 Blob 下载会静默失效，所以这一步不能省——否则用户只会看到"按了没反应"。 */
const props = defineProps({
  info: { type: Object, default: null },
})

const shareState = ref('') // 空 / 'ok' / 'cancel' / 错误信息

async function reShare() {
  shareState.value = ''
  try {
    await shareSavedFile(props.info.path, props.info.filename)
    shareState.value = 'ok'
  } catch (e) {
    const m = (e && (e.message || e.errorMessage)) || ''
    shareState.value = /cancel/i.test(m) || !m ? 'cancel' : '失败：' + m
  }
}
</script>

<template>
  <div v-if="info" class="card" style="padding: 12px 16px; margin-bottom: 12px">
    <div class="row between wrap" style="gap: 10px; align-items: flex-start">
      <div style="min-width: 0; flex: 1">
        <div style="font-size: 13px; font-weight: 600">
          {{ info.filename }}
          <span class="tiny" style="font-weight: 400">
            <template v-if="info.summary"> · {{ info.summary }}</template>
            <template v-else-if="info.count"> · {{ info.count }} 题</template>
            · {{ info.kb }} KB
          </span>
        </div>

        <div class="tiny" style="margin-top: 5px; line-height: 1.6">
          <template v-if="info.where === 'browser'">
            已交给浏览器下载。Chrome / Edge 默认在「下载」文件夹，可在下载记录里点「在文件夹中显示」。
          </template>
          <template v-else>
            当前写在应用缓存里：<span style="font-family: monospace; word-break: break-all">{{ info.path }}</span>
            <br />这不是公开目录，退出应用后可能被系统清理。点右侧「再次打开分享」，在面板里选
            <b>保存到文件</b>（或发送到微信 / 网盘），文件才会真正落到手机的「下载」里。
          </template>
        </div>

        <div v-if="shareState" class="tiny" style="margin-top: 6px" :style="{ color: shareState === 'ok' ? 'var(--green)' : 'var(--amber)' }">
          {{ shareState === 'ok' ? '已重新打开分享面板' : shareState === 'cancel' ? '分享面板已关闭，文件仍未保存' : shareState }}
        </div>
      </div>

      <button v-if="info.where === 'native'" class="btn ghost sm" @click="reShare">再次打开分享</button>
    </div>
  </div>
</template>
