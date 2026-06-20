import { createRouter, createWebHistory } from 'vue-router'
import { useXmpp } from '@/composables/useXmpp'
import DashboardView from '@/views/DashboardView.vue'
import ShellView from '@/views/ShellView.vue'
import LoginView from '@/views/LoginView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
    },
    {
      path: '/',
      name: 'dashboard',
      component: DashboardView,
      meta: { requiresAuth: true },
    },
    {
      path: '/shell',
      name: 'shell',
      component: ShellView,
      meta: { requiresAuth: true },
    },
  ],
})

router.beforeEach((to) => {
  const { status } = useXmpp()
  // During 'connecting', the App.vue spinner is shown — don't redirect yet.
  // Only block access when we know the user is not (and won't be) authenticated.
  if (to.meta.requiresAuth && status.value !== 'connected' && status.value !== 'connecting') {
    return { name: 'login' }
  }
  if (to.name === 'login' && status.value === 'connected') {
    return { name: 'dashboard' }
  }
})

export default router
