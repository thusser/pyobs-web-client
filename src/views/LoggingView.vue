<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useXmpp } from '@/composables/useXmpp'

const { events, clearEvents } = useXmpp()

const moduleFilter = ref('')
const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

const logEvents = computed(() =>
  events.value.filter(
    (e) => e.type === 'LogEvent' && (moduleFilter.value === '' || e.module === moduleFilter.value),
  ),
)

const knownModules = computed(() => {
  const s = new Set(events.value.filter((e) => e.type === 'LogEvent').map((e) => e.module))
  return [...s].sort()
})

watch(logEvents, () => {
  if (!autoScroll.value) return
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
})

function levelClass(level: string): string {
  switch (level?.toUpperCase()) {
    case 'DEBUG':    return 'text-secondary'
    case 'WARNING':  return 'text-warning'
    case 'ERROR':
    case 'CRITICAL': return 'text-danger'
    default:         return 'text-light'
  }
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}
</script>

<template>
  <div class="d-flex flex-column" style="height: calc(100vh - 6rem)">
    <div class="d-flex align-items-center gap-3 mb-3 flex-wrap">
      <h5 class="text-light fw-semibold mb-0">Logging</h5>

      <select
        v-model="moduleFilter"
        class="form-select form-select-sm bg-dark border-secondary text-light ms-auto"
        style="max-width: 180px"
      >
        <option value="">All modules</option>
        <option v-for="m in knownModules" :key="m" :value="m">{{ m }}</option>
      </select>

      <div class="form-check form-switch mb-0">
        <input
          id="auto-scroll"
          v-model="autoScroll"
          class="form-check-input"
          type="checkbox"
          role="switch"
        />
        <label class="form-check-label text-muted" for="auto-scroll" style="font-size:0.8rem">Auto-scroll</label>
      </div>

      <button class="btn btn-outline-secondary btn-sm" @click="clearEvents">
        <i class="bi bi-trash me-1"></i>Clear
      </button>
    </div>

    <div
      ref="logContainer"
      class="flex-grow-1 overflow-auto rounded-3 p-2"
      style="background-color: #111316; font-family: monospace; font-size: 0.8rem"
    >
      <p v-if="logEvents.length === 0" class="text-muted text-center mt-4" style="font-size:0.85rem">
        No log events yet.
      </p>

      <table v-else class="w-100">
        <tbody>
          <tr v-for="ev in logEvents" :key="ev.uuid" :class="levelClass(String(ev.data['level'] ?? ''))">
            <td class="text-secondary pe-3 text-nowrap">{{ formatTime(ev.timestamp) }}</td>
            <td class="pe-3 text-nowrap" style="min-width: 4rem">{{ String(ev.data['level'] ?? '').toUpperCase() }}</td>
            <td class="pe-3 text-nowrap text-muted">{{ ev.module }}</td>
            <td class="text-break">{{ String(ev.data['message'] ?? '') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
