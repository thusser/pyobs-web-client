<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useXmpp } from '@/composables/useXmpp'
import type { CommandSchema, WireType } from '@/pyobs-codec'

const { modules, executeMethod } = useXmpp()

const selectedJid = ref('')
const selectedMethodKey = ref('') // `${ifaceName}::${methodName}` — command names aren't unique across interfaces
const paramValues = ref<Record<string, string>>({})
const result = ref<{ success: boolean; value: unknown; errorClass?: string } | null>(null)
const running = ref(false)

const selectedModule = computed(() => modules.value.find((m) => m.jid === selectedJid.value))

// Every interface this module actually implements, with the commands it
// actually publishes — sourced live from disco#info, nothing pre-generated.
const methodsByIface = computed((): Array<{ iface: string; methods: string[] }> => {
  if (!selectedModule.value) return []
  return Object.entries(selectedModule.value.interfaces)
    .map(([iface, schema]) => ({ iface, methods: Object.keys(schema.commands).sort() }))
    .filter((g) => g.methods.length > 0)
    .sort((a, b) => a.iface.localeCompare(b.iface))
})

const currentIfaceName = computed(() => selectedMethodKey.value.split('::')[0] ?? '')
const currentMethodName = computed(() => selectedMethodKey.value.split('::')[1] ?? '')

const currentCommandSchema = computed((): CommandSchema | null => {
  const iface = selectedModule.value?.interfaces[currentIfaceName.value]
  return (iface?.commands[currentMethodName.value] as CommandSchema | undefined) ?? null
})

const currentEnums = computed(
  (): Record<string, string[]> =>
    (selectedModule.value?.interfaces[currentIfaceName.value]?.enums as Record<string, string[]> | undefined) ?? {},
)

function unwrapOptional(type: WireType): { inner: WireType; optional: boolean } {
  return typeof type === 'object' && type.kind === 'optional' ? { inner: type.inner, optional: true } : { inner: type, optional: false }
}

type WidgetKind = 'bool' | 'number' | 'string' | 'enum' | 'unsupported'

function widgetKind(type: WireType): WidgetKind {
  if (type === 'bool') return 'bool'
  if (type === 'int32' || type === 'float64') return 'number'
  if (type === 'string' || type === 'datetime') return 'string'
  if (typeof type === 'object' && type.kind === 'enum') return 'enum'
  return 'unsupported' // array/struct/any — pyobs-core doesn't publish enough schema to build these
}

function enumOptions(type: WireType): string[] {
  const { inner } = unwrapOptional(type)
  return typeof inner === 'object' && inner.kind === 'enum' ? (currentEnums.value[inner.name] ?? []) : []
}

const hasUnsupportedParam = computed(() =>
  (currentCommandSchema.value?.params ?? []).some((p) => widgetKind(unwrapOptional(p.type).inner) === 'unsupported'),
)

function formatWireType(type: WireType): string {
  if (typeof type === 'string') return type
  if (type.kind === 'enum') return `enum(${type.name})`
  if (type.kind === 'struct') return `struct<${type.name}>`
  if (type.kind === 'array') return `array<${formatWireType(type.item)}>`
  return `optional<${formatWireType(type.inner)}>`
}

// A <select> whose bound value doesn't match any of its <option>s renders
// blank instead of showing the placeholder — seed every param with a value
// that actually matches one of its widget's options (bool has no empty
// option, so it needs 'true' rather than ''). Non-optional number params
// also need a real seeded value: an empty number input must never silently
// become nil for a non-optional int32/float64 param (pyobs-core rejects it,
// e.g. a "%d format: a real number is required, not NoneType" crash).
// Optional params of any kind default to '' regardless — that's the one
// value execute() maps to nil, which is the correct default for "unset".
function defaultParamValue(type: WireType): string {
  const { inner, optional } = unwrapOptional(type)
  if (optional) return ''
  const kind = widgetKind(inner)
  if (kind === 'bool') return 'true'
  if (kind === 'number') return '0'
  return ''
}

watch(selectedJid, () => {
  selectedMethodKey.value = ''
  paramValues.value = {}
  result.value = null
})

watch(currentCommandSchema, (schema) => {
  paramValues.value = Object.fromEntries((schema?.params ?? []).map((p) => [p.name, defaultParamValue(p.type)]))
  result.value = null
})

async function execute() {
  if (!selectedModule.value || !currentCommandSchema.value) return
  running.value = true
  result.value = null
  try {
    const params = currentCommandSchema.value.params.map((p) => {
      const { inner, optional } = unwrapOptional(p.type)
      const raw = paramValues.value[p.name]
      if (optional && (raw === undefined || raw === '')) return null
      const kind = widgetKind(inner)
      if (kind === 'bool') return raw === 'true'
      // Optional + empty was already handled above and returned null; a
      // non-optional number must always resolve to a real number, never nil.
      if (kind === 'number') return Number(raw || 0)
      return raw ?? ''
    })

    result.value = await executeMethod(selectedModule.value.fullJid, currentMethodName.value, params, currentCommandSchema.value)
  } catch (e) {
    result.value = { success: false, value: String(e) }
  } finally {
    running.value = false
  }
}

function formatResult(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') {
    const inline = JSON.stringify(value)
    return inline.length <= 80 ? inline : JSON.stringify(value, null, 2)
  }
  return String(value)
}
</script>

<template>
  <div>
    <h5 class="text-light fw-semibold mb-4">Shell</h5>

    <!-- Module + method selectors -->
    <div class="row g-3 mb-4">
      <div class="col-sm-5">
        <label class="form-label text-muted" style="font-size:0.8rem">Module</label>
        <select
          v-model="selectedJid"
          class="form-select form-select-sm bg-dark border-secondary text-light"
        >
          <option value="">— select module —</option>
          <option v-for="m in modules" :key="m.jid" :value="m.jid">{{ m.name }}</option>
        </select>
      </div>

      <div class="col-sm-7">
        <label class="form-label text-muted" style="font-size:0.8rem">Method</label>
        <select
          v-model="selectedMethodKey"
          class="form-select form-select-sm bg-dark border-secondary text-light"
          :disabled="!selectedJid || methodsByIface.length === 0"
        >
          <option value="">— select method —</option>
          <optgroup v-for="g in methodsByIface" :key="g.iface" :label="g.iface">
            <option v-for="name in g.methods" :key="name" :value="`${g.iface}::${name}`">{{ name }}</option>
          </optgroup>
        </select>
      </div>
    </div>

    <!-- Parameter form -->
    <template v-if="currentCommandSchema">
      <div v-if="currentCommandSchema.params.length" class="mb-3">
        <div
          v-for="param in currentCommandSchema.params"
          :key="param.name"
          class="row align-items-center g-2 mb-2"
        >
          <div class="col-sm-3 text-end">
            <label class="form-label mb-0 text-muted" style="font-size:0.8rem">
              {{ param.name }}
              <span v-if="unwrapOptional(param.type).optional" class="text-secondary ms-1" style="font-size:0.7rem">(optional)</span>
            </label>
          </div>
          <div class="col-sm-6">
            <select
              v-if="widgetKind(unwrapOptional(param.type).inner) === 'bool'"
              v-model="paramValues[param.name]"
              class="form-select form-select-sm bg-dark border-secondary text-light"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
            <select
              v-else-if="widgetKind(unwrapOptional(param.type).inner) === 'enum'"
              v-model="paramValues[param.name]"
              class="form-select form-select-sm bg-dark border-secondary text-light"
            >
              <option value="">—</option>
              <option v-for="opt in enumOptions(param.type)" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input
              v-else-if="widgetKind(unwrapOptional(param.type).inner) !== 'unsupported'"
              v-model="paramValues[param.name]"
              :type="widgetKind(unwrapOptional(param.type).inner) === 'number' ? 'number' : 'text'"
              class="form-control form-control-sm bg-dark border-secondary text-light"
            />
            <span v-else class="text-danger" style="font-size:0.75rem">unsupported param type</span>
          </div>
          <div class="col-sm-3">
            <span class="text-secondary" style="font-size:0.75rem">
              {{ formatWireType(param.type) }}
              <span v-if="param.unit">({{ param.unit }})</span>
            </span>
          </div>
        </div>
      </div>
      <p v-else class="text-muted mb-3" style="font-size:0.85rem">No parameters.</p>

      <button
        class="btn btn-primary btn-sm"
        :disabled="running || hasUnsupportedParam"
        @click="execute"
      >
        <span v-if="running">
          <span class="spinner-border spinner-border-sm me-1" role="status"></span>
          Running…
        </span>
        <span v-else>
          <i class="bi bi-play-fill me-1"></i>
          Execute
        </span>
      </button>
    </template>

    <!-- Result -->
    <div v-if="result !== null" class="mt-4">
      <div
        class="rounded-3 p-3"
        :class="result.success ? 'border-success' : 'border-danger'"
        style="background-color:#1a1d21; border-width:1px; border-style:solid"
      >
        <div class="mb-1" style="font-size:0.75rem" :class="result.success ? 'text-success' : 'text-danger'">
          {{ result.success ? 'Result' : (result.errorClass ? `Error: ${result.errorClass}` : 'Error') }}
        </div>
        <pre class="mb-0 text-light" style="font-size:0.85rem; white-space:pre-wrap">{{ formatResult(result.value) }}</pre>
      </div>
    </div>
  </div>
</template>
