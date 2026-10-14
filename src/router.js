import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'dash', component: () => import('./views/Dashboard.vue'), meta: { title: '总览', ico: '◈' } },
  { path: '/progress', name: 'progress', component: () => import('./views/Progress.vue'), meta: { title: '进度', ico: '◎' } },
  { path: '/banks', name: 'banks', component: () => import('./views/Banks.vue'), meta: { title: '题库', ico: '▤' } },
  { path: '/cards', name: 'cards', component: () => import('./views/Cards.vue'), meta: { title: '卡片', ico: '❑' } },
  { path: '/practice', name: 'practice', component: () => import('./views/Practice.vue'), meta: { title: '练习', ico: '✎' } },
  { path: '/exam', name: 'exam', component: () => import('./views/Exam.vue'), meta: { title: '考试', ico: '⏱' } },
  { path: '/wrong', name: 'wrong', component: () => import('./views/WrongBook.vue'), meta: { title: '错题', ico: '✎' } },
  { path: '/stats', name: 'stats', component: () => import('./views/Stats.vue'), meta: { title: '统计', ico: '▲' } },
  { path: '/settings', name: 'settings', component: () => import('./views/Settings.vue'), meta: { title: '设置', ico: '⚙' } },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})
