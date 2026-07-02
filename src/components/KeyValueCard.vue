<script setup lang="ts">
defineProps<{ title: string; value: unknown }>()

function entries(val: unknown): Array<[string, unknown]> {
  if (val && typeof val === 'object' && !Array.isArray(val)) return Object.entries(val as Record<string, unknown>)
  return [['value', val]]
}

function formatEntry(val: unknown): string {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'boolean') return val ? 'true' : 'false'
  if (typeof val === 'object') {
    const inline = JSON.stringify(val)
    return inline.length <= 60 ? inline : JSON.stringify(val, null, 2)
  }
  return String(val)
}

// Long/nested values get pretty-printed onto multiple lines by formatEntry —
// truncating those to one line with an ellipsis (fine for short scalars)
// would hide real content instead of just shortening it.
function isMultiline(val: unknown): boolean {
  return formatEntry(val).includes('\n')
}
</script>

<template>
  <div class="rounded-3 p-2 mb-2" style="background-color:#15181c; border:1px solid #2d3035">
    <div class="text-muted mb-1" style="font-size:0.7rem; text-transform:uppercase; letter-spacing:0.03em">{{ title }}</div>
    <div v-for="[key, val] in entries(value)" :key="key" class="mb-1" style="font-size:0.8rem">
      <template v-if="isMultiline(val)">
        <div class="text-secondary">{{ key }}</div>
        <pre
          class="text-light mb-0"
          style="white-space: pre-wrap; word-break: break-word; font-size: 0.75rem"
        >{{ formatEntry(val) }}</pre>
      </template>
      <div v-else class="d-flex justify-content-between gap-2">
        <span class="text-secondary text-truncate">{{ key }}</span>
        <span class="text-light" style="max-width: 60%; overflow-wrap: break-word">{{ formatEntry(val) }}</span>
      </div>
    </div>
  </div>
</template>
