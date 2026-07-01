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
- No decision yet on scope: full rewrite of `useXmpp.ts` vs. incremental additions
  (capabilities/state support layered on top of what exists). Given the RPC wire
  format is a hard break, `executeMethod`/`toRpcValue`/`parseRpcValue` need to change
  regardless — the open question is really whether to also add generic state/capability
  subscription in the same pass or as a follow-up.
- `generate-interfaces.sh` needs to default to (or at least be run against) the local
  `../pyobs-core` checkout during this work, not PyPI, or every generated type will be
  stale again immediately.