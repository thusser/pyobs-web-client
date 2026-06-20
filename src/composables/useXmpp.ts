import { ref, readonly } from 'vue'
import { Strophe, $pres, $iq } from 'strophe.js'

export type XmppStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type PyobsModule = {
  jid: string      // bare JID, e.g. camera@localhost
  fullJid: string  // full JID with resource, e.g. camera@localhost/pyobs
  name: string
  features: string[]
}

export type RpcResult = {
  success: boolean
  value: unknown
}

const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
const NS_RPC = 'jabber:iq:rpc'
const PYOBS_RESOURCE = 'pyobs'
const SESSION_JID_KEY = 'xmpp_jid'
const SESSION_PW_KEY = 'xmpp_password'

// Start as 'connecting' immediately if credentials are stored so the first
// render never shows the login screen before the auto-reconnect kicks in.
const status = ref<XmppStatus>(
  sessionStorage.getItem(SESSION_JID_KEY) && sessionStorage.getItem(SESSION_PW_KEY)
    ? 'connecting'
    : 'disconnected',
)
const jid = ref<string>('')
const errorMessage = ref<string>('')
const modules = ref<PyobsModule[]>([])

let connection: InstanceType<typeof Strophe.Connection> | null = null
let connectionGeneration = 0

function buildWsUrl(domain: string): string {
  if (import.meta.env.VITE_XMPP_WS_URL) {
    return import.meta.env.VITE_XMPP_WS_URL as string
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${domain}:5280/ws`
}

function sendIQ(stanza: Element): Promise<Element> {
  return new Promise((resolve, reject) => {
    connection!.sendIQ(stanza, resolve, reject, 10000)
  })
}

async function fetchModuleInfo(bareJid: string, fullJid: string): Promise<void> {
  let name = Strophe.getNodeFromJid(bareJid) ?? bareJid
  let features: string[] = []

  try {
    // XEP-0030: query the module directly for its identity and features
    const result = await sendIQ(
      $iq({ to: fullJid, type: 'get' })
        .c('query', { xmlns: NS_DISCO_INFO })
        .tree(),
    )
    const identities = Array.from(result.getElementsByTagName('identity'))
    features = Array.from(result.getElementsByTagName('feature'))
      .map((f) => f.getAttribute('var') ?? '')
      .filter(Boolean)
    name = identities[0]?.getAttribute('name') ?? name
  } catch {
    // use defaults derived from JID
  }

  modules.value = [
    ...modules.value.filter((m) => m.jid !== bareJid),
    { jid: bareJid, fullJid, name, features },
  ]
}

function handlePresence(presence: Element): boolean {
  const from = presence.getAttribute('from')
  if (!from) return true

  // pyobs modules always connect with resource "pyobs"
  if (Strophe.getResourceFromJid(from) !== PYOBS_RESOURCE) return true

  const type = presence.getAttribute('type') ?? 'available'
  const bareJid = Strophe.getBareJidFromJid(from)

  if (type === 'unavailable') {
    modules.value = modules.value.filter((m) => m.jid !== bareJid)
  } else {
    fetchModuleInfo(bareJid, from)
  }

  return true // keep handler active
}

// ── XEP-0009 RPC helpers ──────────────────────────────────────────────────────

function toRpcValue(type: string, value: string | number | boolean): { tag: string; text: string } {
  const str = String(value)
  if (type === 'number') {
    return /^-?\d+$/.test(str.trim())
      ? { tag: 'i4', text: str }
      : { tag: 'double', text: str }
  }
  if (type === 'boolean') {
    return { tag: 'boolean', text: str === 'true' || str === '1' ? '1' : '0' }
  }
  return { tag: 'string', text: str }
}

function parseRpcValue(el: Element): unknown {
  const child = el.firstElementChild
  if (!child) return el.textContent ?? null
  switch (child.localName) {
    case 'nil':     return null
    case 'double':  return parseFloat(child.textContent ?? '0')
    case 'i4':
    case 'int':     return parseInt(child.textContent ?? '0', 10)
    case 'boolean': return child.textContent === '1'
    case 'string':  return child.textContent ?? ''
    case 'array': {
      const data = child.getElementsByTagName('data')[0]
      return data ? Array.from(data.children).map(parseRpcValue) : []
    }
    default:        return child.textContent
  }
}

async function executeMethod(
  fullJid: string,
  methodName: string,
  params: Array<{ type: string; value: string | number | boolean }>,
): Promise<RpcResult> {
  if (!connection) throw new Error('Not connected')

  // Build XEP-0009 methodCall IQ
  const builder = $iq({ to: fullJid, type: 'set' })
    .c('query', { xmlns: NS_RPC })
    .c('methodCall')
    .c('methodName').t(methodName).up()
    .c('params')

  for (const p of params) {
    const { tag, text } = toRpcValue(p.type, p.value)
    builder.c('param').c('value').c(tag).t(text).up().up().up()
  }

  let result: Element
  try {
    result = await sendIQ(builder.tree())
  } catch (err: unknown) {
    // XMPP-level error (item-not-found, forbidden, …)
    const msg = err instanceof Element
      ? (err.getElementsByTagName('text')[0]?.textContent ?? 'XMPP error')
      : String(err)
    return { success: false, value: msg }
  }

  // RPC-level fault
  const faultEl = result.getElementsByTagName('fault')[0]
  if (faultEl) {
    const msg = faultEl.getElementsByTagName('string')[0]?.textContent ?? 'RPC fault'
    return { success: false, value: msg }
  }

  // Success — parse first return value (void methods have no params element)
  const valueEl = result.getElementsByTagName('value')[0]
  return { success: true, value: valueEl ? parseRpcValue(valueEl) : null }
}

// ── connection management ─────────────────────────────────────────────────────

function connect(userJid: string, password: string, silent = false): Promise<void> {
  const myGeneration = ++connectionGeneration
  return new Promise((resolve, reject) => {
    status.value = 'connecting'
    errorMessage.value = ''
    jid.value = userJid

    const domain = Strophe.getDomainFromJid(userJid)
    const wsUrl = buildWsUrl(domain)

    connection = new Strophe.Connection(wsUrl)

    connection.connect(userJid, password, (st: number) => {
      // Ignore callbacks from a superseded connection attempt.
      if (myGeneration !== connectionGeneration) return

      if (st === Strophe.Status.CONNECTED) {
        status.value = 'connected'
        sessionStorage.setItem(SESSION_JID_KEY, userJid)
        sessionStorage.setItem(SESSION_PW_KEY, password)
        // Register presence handler before sending initial presence so the
        // server's roster-presence flood is captured on arrival
        connection!.addHandler(handlePresence, '', 'presence', '')
        connection!.send($pres())
        resolve()
      } else if (st === Strophe.Status.CONNFAIL) {
        // Transient failure — keep credentials so a retry can succeed.
        // In silent mode (auto-reconnect) keep spinner up; otherwise show error.
        if (!silent) {
          status.value = 'error'
          errorMessage.value = 'Connection failed. Check server address.'
        }
        reject(new Error('Connection failed'))
      } else if (st === Strophe.Status.AUTHFAIL) {
        // Wrong password — credentials are definitely bad, clear them.
        status.value = 'error'
        errorMessage.value = 'Authentication failed. Check JID and password.'
        sessionStorage.removeItem(SESSION_JID_KEY)
        sessionStorage.removeItem(SESSION_PW_KEY)
        reject(new Error('Auth failed'))
      } else if (st === Strophe.Status.DISCONNECTED) {
        if (status.value === 'connected') {
          status.value = 'disconnected'
        }
      }
    })
  })
}

function disconnect() {
  sessionStorage.removeItem(SESSION_JID_KEY)
  sessionStorage.removeItem(SESSION_PW_KEY)
  if (connection) {
    connection.disconnect('logout')
    connection = null
  }
  status.value = 'disconnected'
  jid.value = ''
  modules.value = []
}

// Restore session automatically on page reload, with one retry after 1 s in
// case ejabberd is still tearing down the previous WebSocket session.
async function autoReconnect(savedJid: string, savedPassword: string): Promise<void> {
  try {
    await connect(savedJid, savedPassword, true)
  } catch {
    // First attempt failed — wait 1 s (ejabberd cleaning up old session) then retry.
    await new Promise((r) => setTimeout(r, 1000))
    if (sessionStorage.getItem(SESSION_JID_KEY)) {
      await connect(savedJid, savedPassword, true).catch(() => {
        // Both attempts failed; let the user log in manually.
        status.value = 'disconnected'
      })
    }
  }
}

const storedJid = sessionStorage.getItem(SESSION_JID_KEY)
const storedPassword = sessionStorage.getItem(SESSION_PW_KEY)
if (storedJid && storedPassword) {
  autoReconnect(storedJid, storedPassword)
}

export function useXmpp() {
  return {
    status: readonly(status),
    jid: readonly(jid),
    errorMessage: readonly(errorMessage),
    modules: readonly(modules),
    connect,
    disconnect,
    executeMethod,
  }
}
