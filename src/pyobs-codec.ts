// Generic value<->XML codec for pyobs-core 2.0's wire protocol (urn:pyobs:rpc:1
// vocabulary, also reused for PubSub state and disco#info capabilities).
//
// Decoding is schema-less: every value on the wire is self-tagged (<int>,
// <string>, <items>, ...), so xmlToValue needs no type information at all.
// Encoding needs a WireType, fetched live from a module's disco#info schema
// (see parseInterfaceSchema/parseEventSchema below) — a bare JS value alone is
// ambiguous (e.g. "5" could mean int32 or float64), and RPC params must match
// the callee's declared type exactly.

export function localTag(el: Element): string {
  return el.localName
}

// Dedicated XML document for building stanza fragments. `document.createElement`
// (the page's HTML document) puts new elements in the HTML namespace, which
// pollutes outgoing XMPP XML with a stray xmlns — an XML document's
// createElement doesn't have that problem, matching how Strophe itself builds
// stanzas internally (Strophe.xmlGenerator()).
const xmlDoc = document.implementation.createDocument(null, null, null)

function createElement(tag: string): Element {
  return xmlDoc.createElement(tag)
}

// `createElementNS` alone sets the DOM's internal `namespaceURI`, but
// Strophe's Builder.serialize() is a hand-rolled string serializer that only
// emits attributes literally present in `el.attributes` — it never reads
// `namespaceURI`. Without an explicit `xmlns` attribute, this element would
// go out on the wire with no namespace declaration at all, silently
// inheriting whatever ambient namespace its parent happens to have.
export function createNamespacedElement(ns: string, tag: string): Element {
  const elem = xmlDoc.createElementNS(ns, tag)
  elem.setAttribute('xmlns', ns)
  return elem
}

// ── decode: value tag vocabulary -> JS value (no schema needed) ────────────

export function xmlToValue(el: Element): unknown {
  switch (localTag(el)) {
    case 'nil':
      return null
    case 'boolean':
      return el.textContent === 'true'
    case 'int':
      return parseInt(el.textContent ?? '0', 10)
    case 'double':
      return parseFloat(el.textContent ?? '0')
    case 'string':
      return el.textContent ?? ''
    case 'items':
    case 'tuple':
      return Array.from(el.children)
        .filter((c) => localTag(c) === 'item')
        .map((c) => (c.firstElementChild ? xmlToValue(c.firstElementChild) : null))
    case 'dict': {
      const result: Record<string, unknown> = {}
      for (const entry of Array.from(el.children)) {
        if (localTag(entry) !== 'entry') continue
        const keyEl = Array.from(entry.children).find((c) => localTag(c) === 'key')
        const valEl = Array.from(entry.children).find((c) => localTag(c) === 'val')
        const key = keyEl?.firstElementChild ? xmlToValue(keyEl.firstElementChild) : undefined
        const val = valEl?.firstElementChild ? xmlToValue(valEl.firstElementChild) : undefined
        if (key !== undefined) result[String(key)] = val
      }
      return result
    }
    default: {
      // Anything else is a dataclass root (state/capabilities): one child
      // element per field, each wrapping exactly one more self-tagged value.
      const result: Record<string, unknown> = {}
      for (const field of Array.from(el.children)) {
        result[localTag(field)] = field.firstElementChild ? xmlToValue(field.firstElementChild) : null
      }
      return result
    }
  }
}

// ── schema type strings (from disco#info command/state/event schemas) ──────

export type WireType =
  | 'bool'
  | 'int32'
  | 'float64'
  | 'string'
  | 'void'
  | 'datetime'
  | 'any'
  | { kind: 'enum'; name: string }
  | { kind: 'struct'; name: string }
  | { kind: 'array'; item: WireType }
  | { kind: 'optional'; inner: WireType }

export function parseWireType(typeStr: string): WireType {
  const s = typeStr.trim()
  if (s === 'bool' || s === 'int32' || s === 'float64' || s === 'string' || s === 'void' || s === 'datetime') {
    return s
  }
  const enumMatch = /^enum\((.+)\)$/.exec(s)
  if (enumMatch) return { kind: 'enum', name: enumMatch[1]! }
  const structMatch = /^struct<(.+)>$/.exec(s)
  if (structMatch) return { kind: 'struct', name: structMatch[1]! }
  const arrayMatch = /^array<(.+)>$/.exec(s)
  if (arrayMatch) return { kind: 'array', item: parseWireType(arrayMatch[1]!) }
  const optionalMatch = /^optional<(.+)>$/.exec(s)
  if (optionalMatch) return { kind: 'optional', inner: parseWireType(optionalMatch[1]!) }
  return 'any'
}

// ── encode: JS value + WireType -> value element (RPC call params only) ────

export function valueToXml(value: unknown, type: WireType): Element {
  if (typeof type === 'object' && type.kind === 'optional') {
    return value === null || value === undefined ? createElement('nil') : valueToXml(value, type.inner)
  }
  if (value === null || value === undefined) {
    return createElement('nil')
  }
  if (type === 'bool') {
    const el = createElement('boolean')
    el.textContent = value ? 'true' : 'false'
    return el
  }
  if (type === 'int32') {
    const el = createElement('int')
    el.textContent = String(Math.trunc(Number(value)))
    return el
  }
  if (type === 'float64') {
    const el = createElement('double')
    el.textContent = String(Number(value))
    return el
  }
  if (type === 'string' || type === 'datetime' || (typeof type === 'object' && type.kind === 'enum')) {
    const el = createElement('string')
    el.textContent = String(value)
    return el
  }
  if (typeof type === 'object' && type.kind === 'array') {
    const el = createElement('items')
    for (const item of value as unknown[]) {
      const itemEl = createElement('item')
      itemEl.appendChild(valueToXml(item, type.item))
      el.appendChild(itemEl)
    }
    return el
  }
  // struct<Name>/any/void params can't be built from schema alone (pyobs-core
  // doesn't publish struct field lists) — no real command takes one today.
  throw new Error(`Cannot encode a value for wire type ${JSON.stringify(type)}`)
}

// ── versioned feature/namespace strings: urn:pyobs:{kind}:{name}:{version} ─

export type VersionedFeature = { name: string; version: number }

export function parseVersionedFeature(
  kind: 'interface' | 'state' | 'event' | 'capabilities',
  feat: string,
): VersionedFeature | null {
  const prefix = `urn:pyobs:${kind}:`
  if (!feat.startsWith(prefix)) return null
  const rest = feat.slice(prefix.length)
  const idx = rest.lastIndexOf(':')
  if (idx < 0) return null
  const version = Number(rest.slice(idx + 1))
  if (!Number.isFinite(version)) return null
  return { name: rest.slice(0, idx), version }
}

// ── disco#info schema blocks (<{ns}interface>, <{ns}event>) ────────────────

export type FieldSchema = { name: string; type: WireType; unit?: string }
export type CommandSchema = { name: string; params: FieldSchema[] }
// `node` is a display label only (e.g. "state/ICooling/1"), NOT the real
// PubSub node — that's built from the module's JID username, see useXmpp.ts.
export type StateSchema = { node: string; fields: FieldSchema[] }
export type InterfaceSchema = {
  name: string
  version: number
  enums: Record<string, string[]>
  commands: Record<string, CommandSchema>
  state: StateSchema | null
}
export type EventSchema = {
  name: string
  version: number
  enums: Record<string, string[]>
  fields: FieldSchema[]
}

function parseEnums(typesEl: Element): Record<string, string[]> {
  const enums: Record<string, string[]> = {}
  for (const enumEl of Array.from(typesEl.children)) {
    if (localTag(enumEl) !== 'enum') continue
    const name = enumEl.getAttribute('name') ?? ''
    enums[name] = Array.from(enumEl.children)
      .filter((v) => localTag(v) === 'value')
      .map((v) => v.textContent ?? '')
  }
  return enums
}

function parseFields(parent: Element, childTag: string): FieldSchema[] {
  return Array.from(parent.children)
    .filter((f) => localTag(f) === childTag)
    .map((f) => ({
      name: f.getAttribute('name') ?? '',
      type: parseWireType(f.getAttribute('type') ?? 'any'),
      unit: f.getAttribute('unit') ?? undefined,
    }))
}

export function parseInterfaceSchema(el: Element): InterfaceSchema {
  const ref = parseVersionedFeature('interface', el.namespaceURI ?? '')
  const name = ref?.name ?? el.getAttribute('name') ?? ''
  const version = ref?.version ?? 1

  let enums: Record<string, string[]> = {}
  const commands: Record<string, CommandSchema> = {}
  let state: StateSchema | null = null

  for (const child of Array.from(el.children)) {
    const tag = localTag(child)
    if (tag === 'types') {
      enums = parseEnums(child)
    } else if (tag === 'command') {
      const cmdName = child.getAttribute('name') ?? ''
      commands[cmdName] = { name: cmdName, params: parseFields(child, 'parameter') }
    } else if (tag === 'state') {
      state = { node: child.getAttribute('node') ?? '', fields: parseFields(child, 'field') }
    }
  }

  return { name, version, enums, commands, state }
}

export function parseEventSchema(el: Element): EventSchema {
  const ref = parseVersionedFeature('event', el.namespaceURI ?? '')
  const name = ref?.name ?? el.getAttribute('name') ?? ''
  const version = ref?.version ?? 1

  let enums: Record<string, string[]> = {}
  const typesEl = Array.from(el.children).find((c) => localTag(c) === 'types')
  if (typesEl) enums = parseEnums(typesEl)

  return { name, version, enums, fields: parseFields(el, 'field') }
}
