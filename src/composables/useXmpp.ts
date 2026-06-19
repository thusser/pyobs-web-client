import { ref, readonly } from 'vue'
import { Strophe, $pres, $iq } from 'strophe.js'

export type XmppStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type PyobsModule = {
  jid: string
  name: string
  features: string[]
}

const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
const PYOBS_RESOURCE = 'pyobs'
const SESSION_JID_KEY = 'xmpp_jid'
const SESSION_PW_KEY = 'xmpp_password'

const status = ref<XmppStatus>('disconnected')
const jid = ref<string>('')
const errorMessage = ref<string>('')
const modules = ref<PyobsModule[]>([])

let connection: InstanceType<typeof Strophe.Connection> | null = null

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
    { jid: bareJid, name, features },
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

function connect(userJid: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    status.value = 'connecting'
    errorMessage.value = ''
    jid.value = userJid

    const domain = Strophe.getDomainFromJid(userJid)
    const wsUrl = buildWsUrl(domain)

    connection = new Strophe.Connection(wsUrl)

    connection.connect(userJid, password, (st: number) => {
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
        status.value = 'error'
        errorMessage.value = 'Connection failed. Check server address and credentials.'
        sessionStorage.removeItem(SESSION_JID_KEY)
        sessionStorage.removeItem(SESSION_PW_KEY)
        reject(new Error('Connection failed'))
      } else if (st === Strophe.Status.AUTHFAIL) {
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

// Restore session automatically on page reload
const storedJid = sessionStorage.getItem(SESSION_JID_KEY)
const storedPassword = sessionStorage.getItem(SESSION_PW_KEY)
if (storedJid && storedPassword) {
  connect(storedJid, storedPassword).catch(() => {})
}

export function useXmpp() {
  return {
    status: readonly(status),
    jid: readonly(jid),
    errorMessage: readonly(errorMessage),
    modules: readonly(modules),
    connect,
    disconnect,
  }
}
