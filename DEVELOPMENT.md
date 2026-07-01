# Adapting to pyobs-core 2.0

Notes from investigating `../pyobs-core` (currently `2.0.0.dev9`, local checkout) to
figure out how `pyobs-web-client` should change. This is a research log, not a final
plan — it records what's confirmed vs. still open.

## Why this matters

The web client re-implements the pyobs XMPP wire protocol by hand in
`src/composables/useXmpp.ts` (raw Strophe.js stanzas: disco#info, XEP-0009 RPC,
PubSub). It was written against pre-2.0 pyobs-core. A lot changed in comm/interfaces
since `v1.47.0`, and some of it looks like it makes the client's job easier, not just
different.

## Confirmed changes in pyobs-core relevant to the web client

Source: `pyobs/comm/xmpp/xmppcomm.py`, `pyobs/interfaces/interface.py`, and
`git log v1.47.0..HEAD -- pyobs/comm pyobs/events pyobs/interfaces` in `../pyobs-core`.
No `2.0.0` section exists yet in `CHANGELOG.rst` (still dev), so this is read directly
from source/commits.

- **Versioned interface features.** Modules now advertise interfaces via disco#info
  as `urn:pyobs:interface:{Name}:{version}` (was previously unversioned, e.g.
  `pyobs:interface:{Name}`). `XmppComm._get_interfaces` only accepts a feature if the
  remote-advertised version matches the locally known `Interface.version` — a mismatch
  is treated as "not implemented" and logged (`_diagnose_missing_interface`).
- **Capabilities.** Interfaces can declare a `ClassVar[type | None] capabilities`
  dataclass (`Interface.capabilities`). Modules publish these as `<capabilities>`
  elements inside their own disco#info response (namespace
  `urn:pyobs:capabilities:{Interface}:{version}`), via a custom `get_info` handler
  (`XmppComm._get_disco_info`). Clients fetch them with a plain disco#info query
  (`_get_capabilities`) — no RPC call needed to ask "what are your limits/options".
- **State.** Interfaces can also declare a `ClassVar[type | None] state` dataclass.
  Live state is pushed over dedicated PubSub nodes,
  `pyobs:state:{module}:{Interface}:{version}` (namespace
  `urn:pyobs:state:{Interface}:{version}`), serialized via a generic
  `_dataclass_to_xml` / `_xml_to_dataclass` (de)serializer. Clients subscribe once
  (`_subscribe_state`) and get pushed updates plus the current value on subscribe —
  this replaces polling getter methods (e.g. `get_motion_status`) with a
  subscribe-and-receive model.
- **Module lifecycle/presence.** `ModuleState` (READY/ERROR/LOCAL/CLOSED) now rides on
  plain XMPP presence `<show>`/`<status>` (`_set_presence`, `_got_online`,
  `_got_presence_update`, `_jid_got_offline`). A client can get live
  online/offline/error status for every module from presence alone, no polling.
- **RPC layer rewritten** (`new RPC`, `unified serializer` commits) — still XEP-0009
  under the hood, but parameter/return (de)serialization now goes through the same
  dataclass (de)serializer used for state/capabilities, meaning RPC methods can accept
  more than flat primitives now.
- **Events** still ride PEP/PubSub as `pyobs:event:{EventName}`, JSON payload — this
  part looks unchanged from what `useXmpp.ts` already does.
- `ILatLon` interface was removed entirely (`34cb5826`).
- Base `Interface` now exposes `get_state`, `get_capabilities`, `wait_for_state` as
  first-class methods (`pyobs/interfaces/interface.py`).

## Confirmed staleness/breakage in the current web client

- `src/scripts/generate-interfaces.sh` defaults to installing **pyobs-core from PyPI**,
  not the local `../pyobs-core` checkout, unless called with an explicit path arg. The
  committed `src/pyobs-interfaces.ts` still contains `ILatLon` (removed in 2.0), so it
  was generated against a pre-2.0 release.
- `ShellView.vue`'s `ifaceNameFromFeature()` matches features starting with
  `'pyobs:interface:'`. Real features are now `urn:pyobs:interface:{Name}:{version}` —
  this prefix will never match, so **Shell's module/interface method listing is
  currently broken** against a 2.0 backend (would show zero methods for every module).
- `useXmpp.ts` has no concept of capabilities or state subscriptions at all — Dashboard
  just dumps the raw feature string list, and nothing surfaces live module status
  beyond bare online/offline (derived from XMPP presence, which happens to still work
  since presence itself is unchanged in shape, just semantically richer now).
- The interface generator (`generate-interfaces.py`) only extracts abstract method
  signatures with primitive param types (`number | string | boolean`). It has no
  handling for the new `state` / `capabilities` dataclasses, or for versioned feature
  strings.

## Where this points (not yet decided)

The recurring theme: 2.0 replaced a lot of "call a method to find out X" with
"subscribe/query structured data for X" (capabilities via disco#info, state via
PubSub, lifecycle via presence). That's plausibly what makes the client "way simpler":
less hand-rolled polling and RPC plumbing, more generic subscribe-and-render.

Concretely, this could mean:

1. Point `generate-interfaces.sh` at the local `../pyobs-core` checkout (or default to
   it during dev) so generated TS isn't stale, and extend the generator to also emit
   `state`/`capabilities` dataclass shapes, not just methods.
2. Fix (or replace) the versioned-feature parsing (`urn:pyobs:interface:{Name}:{version}`)
   in one shared place instead of duplicating the `pyobs:interface:` prefix check.
3. Have `useXmpp.ts` surface capabilities and live state generically (mirroring
   `XmppComm`'s own disco#info + PubSub state subscription logic) so views like
   Dashboard/Shell can show real module status instead of raw feature-string badges.
4. Possibly drop custom per-view polling/derived state entirely in favor of the
   subscribe-once state model now that it's pushed from the server side.

## Update: the RPC wire format itself changed (breaking, not just additive)

Read `pyobs/comm/xmpp/serializer.py` and `pyobs/comm/xmpp/rpc.py` in full. This is
bigger than "new optional features to adopt" — **Shell's RPC calls will not work
against a 2.0 backend at all**, because the payload encoding inside XEP-0009 changed:

- Old (what `useXmpp.ts` currently speaks): classic XML-RPC values directly inside
  `<value>` — `<value><i4>42</i4></value>`, `<value><string>foo</string></value>`, etc.
  Faults: standard XML-RPC `<fault><value><struct>...`.
- New (`urn:pyobs:rpc:1`, see `serializer.py` docstring): every value is wrapped in a
  `<pyobs:value xmlns="urn:pyobs:rpc:1">` container holding one of a fixed vocabulary
  of tags — `<boolean>`, `<int>`, `<double>`, `<string>`, `<nil>`, `<items>` (list),
  `<tuple>`, `<dict>` (entry/key/val pairs), or `<{namespace}state>` (nested dataclass,
  same shape used for state/capabilities). Faults are now
  `<fault><value><pyobs:fault xmlns="urn:pyobs:rpc:1"><exception>...</exception><message>...</message></pyobs:fault></value></fault>`.
- This **same vocabulary** (`value_to_xml`/`xml_to_value` in `serializer.py`) is reused
  for RPC params, RPC return values, state pubsub payloads, and capability payloads —
  one wire format instead of three separate ad hoc ones. That's the concrete "simpler"
  angle: the web client can implement one generic `valueToXml`/`xmlToValue` pair in TS
  and reuse it everywhere, rather of the current `toRpcValue`/`parseRpcValue` pair that
  only exists for RPC and only knows 3 primitive types.
- Confirmed method params/returns can now be full dataclasses, lists, tuples, dicts —
  not just flat primitives — so Shell's current "one text input per param" form model
  is already an incomplete fit for anything beyond scalars (not new in 2.0, but the
  gap is more visible now since state/capabilities make structured data commonplace).

## Update: confirmed real State/Capabilities dataclass shapes

From `pyobs/interfaces/ICooling.py`, `IMotion.py`, `IFilters.py`:

```python
# ICooling
@dataclass
class CoolingState:
    setpoint: Annotated[float, Unit.CELSIUS] | None
    power: Annotated[int, Unit.PERCENT] | None
    enabled: bool
    time: Time = field(default_factory=Time.now)

# IMotion — nested dataclass + list-of-dataclass example
@dataclass
class DeviceMotionStatus:
    name: str
    status: MotionStatus  # StrEnum

@dataclass
class MotionState:
    status: MotionStatus
    devices: list[DeviceMotionStatus] = field(default_factory=list)
    time: Time = field(default_factory=Time.now)

# IFilters — capabilities example
@dataclass
class FiltersCapabilities:
    filters: list[str] = field(default_factory=list)
```

So state/capabilities generation for TS needs to handle: `Annotated[T, Unit]`
(unwrap to `T`), `T | None`, nested dataclasses, `list[dataclass]`, `StrEnum` fields,
and a couple of common non-primitive field types (`Time`). Manageable with a similar
approach to the existing method-param extraction in `generate-interfaces.py`, but
needs its own code path since it walks dataclass fields, not method signatures.

## Confirmed: version-tagged interface features are brand new (as of today)

`git show 3b4911e9` (commit message: "Version-tag interface disco#info features to
detect mixed-fleet mismatches", dated 2026-07-01 — today) is the exact commit that
changed the feature format from `pyobs:interface:{name}` to
`urn:pyobs:interface:{name}:{version}`. Before that commit, `ShellView.vue`'s
`pyobs:interface:` prefix check was correct. So this isn't old drift — it's the
literal same-day tip of the 2.0 branch. Confirms the web client needs to track
`../pyobs-core` HEAD closely for now, not just "the 2.0 release" as a fixed target.

## Remaining open questions

- Haven't checked whether other `Comm` backends (`local`, `dummy`) matter here — web
  client only ever talks XMPP, so probably irrelevant, but not confirmed.
- `generate-interfaces.sh` needs to default to (or at least be run against) the local
  `../pyobs-core` checkout during this work, not PyPI, or every generated type will be
  stale again immediately. (Resolved in the plan below.)

Scope is resolved: fix the breaking RPC/interface-feature changes **and** add generic
state/capabilities support (Dashboard shows live module status), confirmed with the
user. Full implementation plan below.

## Implementation plan

Not yet approved for execution — captured here for reference. Original plan file:
`/home/husser/.claude/plans/parsed-wiggling-brooks.md`.

### 1. New file `src/pyobs-codec.ts` — generic value↔XML codec

Pure logic, no XMPP dependency, port of `serializer.py`'s `value_to_xml`/`xml_to_value`.

```ts
export type WireType =
  | { kind: 'int' } | { kind: 'double' }   // split, not merged 'number' — Python
                                            // distinguishes int/float on the wire and
                                            // picks <int> vs <double> by declared type,
                                            // not runtime value
  | { kind: 'string' } | { kind: 'boolean' } | { kind: 'nil' }
  | { kind: 'list'; item: WireType }
  | { kind: 'dict'; key: WireType; val: WireType }
  | { kind: 'dataclass'; name: string; namespace: string; fields: Record<string, WireType> }
  | { kind: 'enum' }                        // StrEnum -> plain string on the wire
  | { kind: 'optional'; inner: WireType }
  | { kind: 'any' }

export function valueToXml(doc: Document, value: unknown, type: WireType): Element
export function xmlToValue(el: Element, type: WireType): unknown
export function dataclassToXml(doc: Document, value: Record<string, unknown>, namespace: string, tag: 'state' | 'capabilities', fields: Record<string, WireType>): Element
export function xmlToDataclass(el: Element, fields: Record<string, WireType>): Record<string, unknown>
export function localTag(el: Element): string   // port of tag.split('}')[-1], applied at every dispatch point (top-level and nested item/entry/key/val), since ejabberd round-trips can namespace any child
export type InterfaceRef = { name: string; version: number }
export function parseInterfaceFeature(feat: string): InterfaceRef | null   // urn:pyobs:interface:{name}:{version}
```

Vocabulary mirrors `serializer.py` exactly: `<boolean>`, `<int>`, `<double>`,
`<string>`, `<nil/>`, `<items><item>…</item></items>` (list), `<tuple>` (same shape),
`<dict><entry><key>…</key><val>…</val></entry></dict>`,
`<{namespace}state|capabilities><field>…</field></{namespace}...>` (dataclass, root
namespaced, fields plain).

Deliberate decisions:
- **Do not port the legacy scalar-text fallback** in `_xml_to_dataclass`/`_parse_scalar`
  — nothing on the wire produces that shape anymore; porting it just adds dead-code
  surface to something meant to be simpler.
- `Annotated[T, Unit]` and `T | None` unwrapping happens once, at generation time
  (`generate-interfaces.py` bakes the unwrapped `WireType`), not at codec runtime —
  TS has no runtime `Annotated` to unwrap anyway.

### 2. `scripts/generate-interfaces.py` / `.sh` — regenerate against local checkout

- `.sh`: default `PYOBS_CORE="${1:-../pyobs-core}"` (was `pyobs-core` from PyPI). PyPI
  still only has pre-2.0 releases, so regenerating against it right now just
  reproduces the current stale/wrong file (confirmed: committed `pyobs-interfaces.ts`
  still has `ILatLon`, removed in 2.0). Smoke-test that `pip install --no-deps
  ../pyobs-core` still installs cleanly under dev9's project layout before relying on
  this.
- `.py`: extend `process_interface` to also emit, per interface:
  - `version: int` (from `cls.version`, base default 1).
  - `state` / `capabilities`: `{ name, namespace: f"urn:pyobs:{state|capabilities}:{ClassName}:{version}", fields: Record<str, WireType> } | null`, via a new `dataclass_to_wiretype`/`py_type_to_wiretype` pair (mirrors `py_type_to_ts` but recurses into nested dataclasses and lists-of-dataclass, matches `WireType`'s `int`/`double` split, and maps `StrEnum` → `{kind:'enum'}`).
  - Use `cls.__dict__.get("state")` / `.get("capabilities")` (own-only), not inherited
    `getattr` — avoids a latent case where a subclass interface without its own
    `state` override would get the parent's state shape published under its own
    namespace. No interface in the current set actually hits this case, but own-only
    is the conservative choice.
  - `Time`-typed fields (e.g. `CoolingState.time`) need **no special handling** —
    confirmed `pyobs.utils.time.Time` subclasses `astropy.time.Time`, not `str`/`float`,
    so `value_to_xml` hits its stringify fallback and `xml_to_value` decodes it as a
    plain string (pyobs-core itself doesn't reconstruct a `Time` object from the wire
    either). Generate these fields as `{kind:'string'}`.
- Generated `InterfaceDef` type: `ParamDef.type` becomes `WireType` (was
  `'number'|'string'|'boolean'`); new `version`, `state`, `capabilities` fields added.
- Regenerate `src/pyobs-interfaces.ts` and confirm by diff: `ILatLon` gone,
  `ICooling`/`IMotion`/`IFilters` show non-null `state`/`capabilities`.

### 3. `useXmpp.ts` — RPC rewrite (fixes Shell)

Replace `toRpcValue`/`parseRpcValue` entirely. New `executeMethod(fullJid, methodName,
params: unknown[], paramTypes: WireType[], returnType: WireType)`:

- Build: `<params><param><value><pyobs:value xmlns="urn:pyobs:rpc:1">{valueToXml}</pyobs:value></value></param></params>`, one `<param>` per positional arg in declared order (matches `rpc.py`'s `params_to_xml`).
- Parse success: find the `pyobs:value` under `<params><param><value>`,
  `xmlToValue(children[0], returnType)`; empty `<params/>` → `null` (void return).
- Parse fault: `<fault><value><pyobs:fault xmlns="urn:pyobs:rpc:1"><exception>…</exception><message>…</message></pyobs:fault></value></fault>` → surface `{exception, message}` distinctly (not collapsed to one string) so the UI can show `ClassName: message`.
- XMPP-level IQ error parsing (`item-not-found` etc.) is unaffected by the wire-format
  change — leave as-is.
- `RpcResult` gains an optional `errorClass?: string`.

`parseInterfaceFeature` (from `pyobs-codec.ts`) replaces `ShellView.vue`'s
`ifaceNameFromFeature`. Only accept an interface if the remote-advertised version
matches `PYOBS_INTERFACES[name].version` — same behavior as pyobs-core's own client
(mismatch = treated as absent). Collect mismatches per module
(`PyobsModule.unmatchedInterfaces: InterfaceRef[]`) in `fetchModuleInfo` for the
Dashboard badge (§6).

`ShellView.vue`'s one-input-per-param form is kept as-is — every real interface method
today takes only primitive scalar params (grep-confirmed: `set_filter(filter_name:
str)`, `set_cooling(enabled, setpoint)`, `stop_motion(device: str | None)`, none take
list/dict/dataclass params). Only change: read `WireType` instead of the old
`ParamType` string when choosing the input widget (`int`/`double` → number input,
`boolean` → select, `string` → text; `optional`/nil affects the existing "(optional)"
label).

### 4. Capabilities — piggyback on `fetchModuleInfo`'s existing disco#info query

No new IQ round trip. `_get_disco_info` (pyobs-core) already appends `<capabilities>`
siblings of `<feature>` inside the same `<query>` `fetchModuleInfo` already parses.
For each version-matched interface with non-null `capabilities`, look for a
`<capabilities>` child namespaced `urn:pyobs:capabilities:{Interface}:{version}` and
decode with `xmlToDataclass`. Add `capabilities: Record<string, unknown>` (keyed by
interface name) to `PyobsModule`.

### 5. State subscription — reference-counted, mirrors `xmppcomm.py`'s subscribe model

New function on the `useXmpp()` return object:

```ts
function subscribeState(bareJid: string, interfaceName: string): { value: ComputedRef<unknown>; unsubscribe: () => void }
```

- Module-level `stateStore: Ref<Map<string /* "jid:Interface" */, unknown>>`, plus a
  ref-count map (`stateRefCounts`) and a set of nodes already subscribed
  (`stateNodeSubscribed`) — ejabberd tracks real subscriptions per (JID, node), so the
  client must not send a redundant `subscribe` IQ per component, and must only send
  `unsubscribe` when the *last* subscriber drops.
- Node naming matches `_state_node`/`_state_namespace`:
  `pyobs:state:{moduleUsername}:{InterfaceName}:{version}`, namespace
  `urn:pyobs:state:{InterfaceName}:{version}`.
- On first subscribe for a key: send `subscribe` IQ to `pubsub.{domain}`, retrying on
  `item-not-found` (publisher may not have published yet — same as pyobs-core's own
  `_subscribe_with_retry`, ~30 attempts / 1s apart, not an error to surface), then
  `get_items` (max_items=1) to fetch the current value in case a live push races the
  subscribe ack.
- `handlePubsubMessage` gains a second branch: `node.startsWith('pyobs:state:')` →
  look up the registered `{key, fields}` for that node, `xmlToDataclass`, reassign a
  new `Map` onto `stateStore.value` (stay consistent with this file's existing style
  of reassigning refs rather than mutating in place, e.g. `modules.value = [...]`).
- `unsubscribe()` decrements the ref count; at zero, sends the ejabberd `unsubscribe`
  IQ and drops bookkeeping.
- Consumers (Dashboard) call `subscribeState` and `unsubscribe()` in their own
  mount/unmount lifecycle.

### 6. Dashboard — generic state cards + version-mismatch badge

New `src/components/ModuleStateCard.vue`: given `{ interfaceName, state,
fields: Record<string, WireType> }`, renders label/value pairs generically
(`Object.entries`) — booleans as badges, numbers as-is, nested/list fields via the
same compact-JSON fallback `ShellView.vue` already uses for RPC results
(`formatResult`, worth extracting to a shared util both can import). No per-interface
hardcoding (no "if ICooling then show temp" branches) — this is what keeps it
data-driven per the user's ask.

`DashboardView.vue`: for each module, for each version-matched interface with
non-null `PYOBS_INTERFACES[name].state`, call `subscribeState` and render a
`ModuleStateCard` when a value is available. Also render a small warning badge (e.g.
"interface version mismatch: IFoo (remote v2, client v1)") when
`module.unmatchedInterfaces` is non-empty.

### Sequencing

Each phase is independently buildable/type-checkable, and later phases depend on
earlier ones:

1. `pyobs-codec.ts` (self-contained).
2. Generator changes + regenerate `pyobs-interfaces.ts` against `../pyobs-core` — hard
   prerequisite for 3–4 (they consume the new generated shape).
3. RPC rewrite (`useXmpp.ts` + `ShellView.vue`) — fixes the currently-broken Shell,
   independently shippable.
4. Capabilities in `fetchModuleInfo`.
5. State subscription + Dashboard cards — largest, most novel piece; done last.

### Critical files

- `src/pyobs-codec.ts` (new)
- `src/pyobs-interfaces.ts` (regenerated, not hand-edited)
- `scripts/generate-interfaces.py`, `scripts/generate-interfaces.sh`
- `src/composables/useXmpp.ts`
- `src/views/ShellView.vue`
- `src/views/DashboardView.vue`
- `src/components/ModuleStateCard.vue` (new)
- Reference only, not modified: `../pyobs-core/pyobs/comm/xmpp/{serializer,rpc,xmppcomm}.py`, `../pyobs-core/pyobs/interfaces/interface.py`

### Verification

- `npm run type-check` and `npm run build` after each phase — the `WireType`/
  `InterfaceDef` shape changes are exactly what `vue-tsc` catches immediately given
  how tightly `ShellView.vue` destructures `param.type` today.
- **Live end-to-end verification against the real ejabberd server**: a live server
  with real pyobs-core `2.0.0.dev9` modules (`camera`, `telescope`, …, password
  `pyobs`, TLS errors ignored) is available at `localhost`. Run `npm run dev`, log
  in, and exercise: Shell RPC calls against a real module (e.g. `set_filter` on a
  filter wheel, checking both success and a deliberate-failure fault path),
  capabilities showing up on Dashboard for modules that publish them, live state
  updates rendering and updating on Dashboard. This is the primary correctness check
  for the new wire-format code, in place of synthetic unit tests — skipping added
  test infra (vitest) for this pass since real end-to-end verification is available
  and more authoritative than a mocked round-trip test would be.
- Before connecting to the live server for the first time, confirm with the user
  which account/resource the web client itself should log in as (reusing one of the
  existing module accounts with a distinct XMPP resource, e.g.
  `camera@localhost/webclient`, vs. a separate dedicated account) — not yet
  established.

### Open items carried forward (low-risk, noted for the record)

- `int`/`double` `WireType` split is a breaking rename of the generated file's shape,
  contained entirely within this codebase — no external consumers.
- Own-only (`__dict__.get`) state/capabilities extraction is the conservative choice;
  revisit if live testing surfaces an interface where inherited state should have
  been picked up.

## Paused: pyobs-core needs a change first

Two corrections to the plan above, from re-checking assumptions before starting
implementation:

- **XmppComm only.** Confirmed with the user — `local`/`dummy` `Comm` backends are out
  of scope, the web client only ever needs to speak XMPP.
- **State/capabilities don't need codegen at all.** The wire format is genuinely
  self-describing: every value is wrapped in a tagged element (`<int>`, `<double>`,
  `<string>`, `<boolean>`, `<nil>`, `<items>`, `<dict>`, `<{ns}state>`), so a generic
  recursive decoder can render arbitrary state/capability payloads with no
  pre-generated field-type schema. §2 and §6 of the plan above (extending the
  generator to emit `state`/`capabilities` `WireType` shapes) are unnecessary —
  decode dynamically instead.

But RPC method **calls** are a different story — checked `pyobs/comm/proxy.py`
(pyobs-core's own Python-side client proxy): it does **not** introspect the remote
over the wire either. It matches the disco#info-advertised interface name+version
against a **locally installed copy of the same `pyobs.interfaces` Python package**
and pulls method signatures from that shared, pre-known contract. There is no
XEP-0009 (or other) introspection call that returns method names/params/docs over
XMPP. So a JS client genuinely cannot know what params `set_filter` takes, or that it
exists, without either (a) a generated file mirroring the Python interfaces (today's
approach, keeps working for methods even though it's now unneeded for
state/capabilities), or (b) pyobs-core itself gaining a wire-level way to describe
method signatures — which doesn't exist yet.

User's call: **stop the web client work here and change pyobs-core first** — add
whatever's needed there so RPC method introspection also becomes wire-native, fully
realizing the "no shared codegen needed" idea for 2.0. Web client implementation is
on hold pending that.