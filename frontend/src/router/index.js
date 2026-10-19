import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores'
import Login from '../views/Login.vue'
import Dashboard from '../views/Dashboard.vue'
import Config from '../views/Config.vue'

const routes = [
  {
    path: '/',
    name: 'login',
    component: Login,
    meta: { guest: true },
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: Dashboard,
    meta: { auth: true },
  },
  {
    path: '/config',
    name: 'config',
    component: Config,
    meta: { auth: true },
  },
  // 任何未匹配路径都收敛到根，由守卫按登录态分流。
  // 这样 /admin、/index.html 之类的手误输入也有确定行为。
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

/**
 * 路由守卫：登录态是唯一分流依据。
 *
 * Worker 不再返回任何 HTML 页面，所有页面路由都落到这里。所以
 * "看到两个不同样式的登录页"这种事不可能再发生——登录页只有
 * Login.vue 一个实现。
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // 首次进入时探测一次登录态（/api/session，不鉴权）
  if (!auth.ready) await auth.probe()

  if (to.meta.auth && !auth.logged) {
    return { name: 'login' }
  }
  if (to.meta.guest && auth.logged) {
    return { name: 'dashboard' }
  }
  return true
})

export default router
