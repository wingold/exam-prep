<script setup>
/* 统一的线性图标集：24 网格、1.8 描边、圆端点。
   全部用 currentColor，颜色交给外层控制，避免图标各处自己带色。 */
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
  stroke: { type: [Number, String], default: 1.8 },
})

const PATHS = {
  /* 导航 */
  gauge: '<path d="M3.6 18.5a8.4 8.4 0 1 1 16.8 0"/><path d="m12 18 4.4-4.6"/><circle cx="12" cy="18.6" r="1.5" fill="currentColor" stroke="none"/>',
  target: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  layers: '<path d="M12 3.2 3.4 7.4 12 11.6l8.6-4.2z"/><path d="M3.4 12.1 12 16.3l8.6-4.2"/><path d="M3.4 16.6 12 20.8l8.6-4.2"/>',
  cards: '<rect x="3.2" y="7.7" width="12.9" height="12.9" rx="3.1"/><path d="M7.9 7.7V6.1a2.6 2.6 0 0 1 2.6-2.6h7.9a2.6 2.6 0 0 1 2.6 2.6v7.9a2.6 2.6 0 0 1-2.6 2.6h-1.5"/>',
  pencil: '<path d="M12.5 20.4H21"/><path d="M16.6 3.4a2.1 2.1 0 0 1 3 3L8.1 17.9l-4.2 1.2 1.2-4.2z"/>',
  timer: '<circle cx="12" cy="13.6" r="7.6"/><path d="M12 10.2v3.6l2.3 2.2"/><path d="M9.4 2.4h5.2"/>',
  flag: '<path d="M6 21.2V3.4"/><path d="M6 4h9.6l-1.7 3.6 1.7 3.6H6z"/>',
  chart: '<path d="M3.6 20.4h16.8"/><path d="M6.8 20.4v-5.2"/><path d="M12 20.4v-9"/><path d="M17.2 20.4V6.6"/>',
  sliders: '<path d="M3.6 7.4h8.2"/><path d="M16.4 7.4h4"/><circle cx="14.1" cy="7.4" r="2.2"/><path d="M3.6 16.6h3.6"/><path d="M11.8 16.6h8.6"/><circle cx="9.5" cy="16.6" r="2.2"/>',
  grid: '<rect x="3.4" y="3.4" width="7.2" height="7.2" rx="2.2"/><rect x="13.4" y="3.4" width="7.2" height="7.2" rx="2.2"/><rect x="3.4" y="13.4" width="7.2" height="7.2" rx="2.2"/><rect x="13.4" y="13.4" width="7.2" height="7.2" rx="2.2"/>',

  /* 状态与操作 */
  check: '<path d="m4.8 12.6 4.9 4.9 9.5-10.6"/>',
  x: '<path d="M6.2 6.2 17.8 17.8"/><path d="M17.8 6.2 6.2 17.8"/>',
  plus: '<path d="M12 5.2v13.6"/><path d="M5.2 12h13.6"/>',
  minus: '<path d="M5.2 12h13.6"/>',
  chevronRight: '<path d="m9.6 5.4 6.6 6.6-6.6 6.6"/>',
  chevronDown: '<path d="m5.4 9.6 6.6 6.6 6.6-6.6"/>',
  chevronUp: '<path d="m5.4 14.4 6.6-6.6 6.6 6.6"/>',
  arrowLeft: '<path d="M19.4 12H4.6"/><path d="m10.8 5.8-6.2 6.2 6.2 6.2"/>',
  arrowRight: '<path d="M4.6 12h14.8"/><path d="m13.2 5.8 6.2 6.2-6.2 6.2"/>',
  sync: '<path d="M3.6 12a8.4 8.4 0 0 1 14.2-6L20.4 8.6"/><path d="M20.4 4.2v4.6h-4.6"/><path d="M20.4 12a8.4 8.4 0 0 1-14.2 6L3.6 15.4"/><path d="M3.6 19.8v-4.6h4.6"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 2"/>',
  calendar: '<rect x="3.4" y="5.2" width="17.2" height="15.4" rx="3"/><path d="M8 2.8v4.4"/><path d="M16 2.8v4.4"/><path d="M3.4 10.4h17.2"/>',
  sparkles: '<path d="m11.6 3.4 1.8 4.4 4.4 1.8-4.4 1.8-1.8 4.4-1.8-4.4L5.4 9.6l4.4-1.8z"/><path d="m18.2 15.2.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"/>',
  upload: '<path d="M12 16.2V3.8"/><path d="m7.4 8.4 4.6-4.6 4.6 4.6"/><path d="M4.4 15.6v2.6a2.2 2.2 0 0 0 2.2 2.2h10.8a2.2 2.2 0 0 0 2.2-2.2v-2.6"/>',
  download: '<path d="M12 3.8v12.4"/><path d="m7.4 11.6 4.6 4.6 4.6-4.6"/><path d="M4.4 15.6v2.6a2.2 2.2 0 0 0 2.2 2.2h10.8a2.2 2.2 0 0 0 2.2-2.2v-2.6"/>',
  trash: '<path d="M4.4 6.9h15.2"/><path d="M9.4 6.9V4.7a1.3 1.3 0 0 1 1.3-1.3h2.6a1.3 1.3 0 0 1 1.3 1.3v2.2"/><path d="m6.4 6.9.8 12.3a1.7 1.7 0 0 0 1.7 1.6h6.2a1.7 1.7 0 0 0 1.7-1.6l.8-12.3"/><path d="M10.4 10.8v6.2"/><path d="M13.6 10.8v6.2"/>',
  edit: '<path d="M11.4 4.6H5.6a2.2 2.2 0 0 0-2.2 2.2v11.6a2.2 2.2 0 0 0 2.2 2.2h11.6a2.2 2.2 0 0 0 2.2-2.2v-5.8"/><path d="M17.2 3.2a2 2 0 0 1 2.9 2.8L12.6 13.6l-3.7.9.9-3.7z"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m15.8 15.8 4.4 4.4"/>',
  alert: '<path d="M12 4.2 21.2 20H2.8z"/><path d="M12 9.6v4.4"/><circle cx="12" cy="17.1" r=".95" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4"/><circle cx="12" cy="7.8" r=".95" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13.4 2.6 4.8 13.8h6.2l-.4 7.6 8.6-11.2h-6.2z"/>',
  book: '<path d="M4.4 5.4a2.4 2.4 0 0 1 2.4-2.4h12.8v17.6H6.8a2.4 2.4 0 0 0-2.4 2.4z"/><path d="M4.4 18.2a2.4 2.4 0 0 1 2.4-2.4h12.8"/>',
  flame: '<path d="M12 2.8c3.4 3 5.4 5.6 5.4 8.6a5.4 5.4 0 0 1-10.8 0c0-1.6.6-3 1.8-4.4.4 1.6 1.2 2.4 2.2 2.6-.2-2.4.2-4.6 1.4-6.8z"/>',
  folder: '<path d="M3.6 7.6a2.4 2.4 0 0 1 2.4-2.4h3.4l2.2 2.6h6.8a2.4 2.4 0 0 1 2.4 2.4v7.4a2.4 2.4 0 0 1-2.4 2.4H6a2.4 2.4 0 0 1-2.4-2.4z"/>',
  more: '<circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
}

const inner = computed(() => PATHS[props.name] ?? PATHS.info)
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="inner"
  />
</template>

<style scoped>
.icon {
  display: inline-block;
  flex: none;
  vertical-align: -0.15em;
}
</style>
