import { createRouter, createWebHashHistory } from 'vue-router'

/* 顺序即侧栏顺序：先「今天要做什么」，再「查数据」，最后「设配置」 */
const routes = [
  { path: '/', name: 'dash', component: () => import('./views/Dashboard.vue'), meta: { title: '总览', icon: 'gauge' } },
  { path: '/practice', name: 'practice', component: () => import('./views/Practice.vue'), meta: { title: '练习', icon: 'pencil' } },
  { path: '/cards', name: 'cards', component: () => import('./views/Cards.vue'), meta: { title: '卡片', icon: 'cards' } },
  { path: '/wrong', name: 'wrong', component: () => import('./views/WrongBook.vue'), meta: { title: '错题', icon: 'flag' } },
  { path: '/exam', name: 'exam', component: () => import('./views/Exam.vue'), meta: { title: '考试', icon: 'timer' } },
  { path: '/progress', name: 'progress', component: () => import('./views/Progress.vue'), meta: { title: '进度', icon: 'target' } },
  { path: '/banks', name: 'banks', component: () => import('./views/Banks.vue'), meta: { title: '题库', icon: 'layers' } },
  { path: '/stats', name: 'stats', component: () => import('./views/Stats.vue'), meta: { title: '统计', icon: 'chart' } },
  { path: '/settings', name: 'settings', component: () => import('./views/Settings.vue'), meta: { title: '设置', icon: 'sliders' } },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})
