# @chatpanel/events

The canonical ChatPanel **event-log** and **capability** contracts. Pure, dependency-free
ESM — the identical code runs in the extension (browser, MV3/CSP-safe), the gateway and
the bridge, the same way [`@chatpanel/pii`](https://github.com/chatpanel/chatpanel-pii)
does.

Two contracts everything else inherits from:

- **The event schema** — append-only, versioned forever, metadata only, and ordered
  **without clocks**.
- **The capability signature** — one call shape a rule, a schedule, the user or a model
  all invoke identically.

## Why it exists

A ChatPanel run should be reconstructable: what context was assembled, which capability
ran, in which class and on which runtime, what was redacted, and what left the device.
That record is only trustworthy if it is *checkable*, so this package ships the
invariants alongside the types.

## Ordering without clocks

```js
import { linearize } from '@chatpanel/events'
```

> Replay orders events by topological sort over `causes`, breaking ties by `(host, seq)`
> with hosts in lexicographic id order. **Wall time is never consulted.**

Once two hosts append concurrently a timestamp is not an order — clocks skew, and two
hosts can stamp the same millisecond. `at` is advisory and shown to humans; `(host, seq)`
and `causes` are authority. `linearize()` is therefore a function of the event *set*, not
of the array it was handed.

## Durable facts, not streams

Market ticks, live captions and DOM mutations are **not** events. They live in an
in-memory ring buffer; only the windowed aggregate that entered a model request or
crossed the device boundary is promoted. This is structural — there is no event type
that would accept a per-tick item — because durably logging a caption stream is roughly
3 MB per meeting and 5.5 GB a year.

## Metadata only

Events carry [`Ref`](./ref.js)s and counts, never content:

```js
makeRef({ kind: 'note', id: 'n_88', hash: 'sha256:…', range: { from: 10, to: 40 } })
```

Replay resolves a `Ref` by hash: match → exact reconstruction; absent or crypto-shredded
→ `verified-but-unavailable`. It never silently substitutes today's version of the note.
`privacy.redacted` carries how many of each entity type were redacted and never the
values — a log of what was redacted must not itself contain the redacted data.

## The capability signature

```js
validateCapability({
  id: 'page.actions', version: '1.0.0', class: 'R',
  requires: ['tab'], provides: ['page.tools'],
  reads: ['page'], writes: ['page'],
  egress: 'none', effects: 'non-replayable',
  disclose: () => ({ name: 'page.actions', gist: 'Act on the current web page' }),
  output: { schema: …, render: (v) => … },
  invoke: async (input, ctx) => …,
})
```

`actor` on an invocation is what makes capabilities turn-independent. `requirements`
(`maxLatencyMs`, `deterministic`, `egress`, `maxCostUsd`) is what a router dispatches on —
*what must be true*, not *which model* — and `canSatisfy()` **refuses** rather than
silently exceeding a budget.

Class is intrinsic (a determinism guarantee); latency is host-bound. The two are never
fused into one table.

`toModelSchema()` is an **allowlist** built from three fields, never an omit-list — so
`invoke`, `effects`, `cost`, `writes` and `egress` cannot leak into a model request.

## Stores — persistence is a host adapter

```js
const log   = createLogStore(adapter)    // append-only events
const blobs = createBlobStore(adapter)   // content-addressed, deduped
```

The *semantics* live here; each host supplies the storage underneath — IndexedDB in the
extension, SQLite on a gateway or daemon, a capped ring buffer colocated. An in-memory
adapter ships for tests, colocated hosts and the replay harness.

`append()` is **idempotent on event id**, so replicating to a warm tier can retry
safely — the log-level counterpart of the idempotency keys capabilities carry. A seq that
moves *backwards* for a host is rejected as a corrupt writer; gaps are allowed, because
eviction must not corrupt the log. `cursor()` and `since()` are the replication pair.

The two stores are separate so **crypto-shredding** works: `blobs.shred(hash)` drops the
payload and leaves a tombstone, so "delete this meeting" can be honoured against an
append-only log while every event that referenced it, and the causality chain, stay
intact. Replay then reports `verified-but-unavailable`.

## The registry — effects and reactive availability

```js
const reg = createRegistry({ onEvent })
reg.register({ name: 'page-tools', requires: ['tab'], apply(ctx) {
  ctx.effect(() => { const off = arm(); return () => off() })   // unwinds automatically
}})
const withdraw = reg.provide('tab', tab)   // page-tools activates
withdraw()                                  // page-tools deactivates and unwinds
```

This is the runtime half of the capability contract: `requires`/`provides` in a
declaration only mean something because something binds them here. Two rules carry it,
and each prevents a specific bug class:

1. **LIFO disposal** — inverses run in reverse order of registration, so each meets the
   state its own application produced.
2. **Dependents deactivate *before* a provider's binding is removed** — a component
   being torn down because its provider is leaving is running teardown that frequently
   *needs* the very capability being withdrawn (closing a pool means handing connections
   back). Remove the binding first and that teardown reaches for something already gone.

A failing component is recorded on itself, unwinds whatever it registered, and leaves
its siblings running. A dependency cycle simply leaves its components permanently
inactive — and unlike a schedule-dependent deadlock it is visible from the declarations
alone, so `pending()` can report it at load time.

No dependency *resolution*: this binds availability, it does not solve versions.

## Invariants

```js
checkInvariants(events) // → [] when the log is sound
```

| | |
|---|---|
| **I1** | Model-visible input is reconstructable from the log |
| **I2** | Every egress is recorded (`controlled: false` for delegated agents) |
| **I3** | Non-pure invocations carry an idempotency key |
| **I4** | Every activation has a recorded inverse |
| **I5** | Ephemeral streams never become durable facts |
| **I6** | Replay is deterministic |

I3 is additionally structural: a non-pure `capability.invoked` without a key fails
`validateEvent`, so it cannot enter the log at all.

## The replay harness

```js
const report = replay(parseJsonl(log), { blobs })
if (!report.ok) { console.error(formatReport(report)); process.exit(1) }
```

Run it in CI and the determinism claim stops being a comment. It reproduces order from
`(host, seq)` and `causes`, checks I1–I6, and resolves every resident `Ref` by hash.

Two outcomes are worth distinguishing, because they look similar and mean opposite
things:

- a blob that is **gone** (crypto-shredded or evicted) reports *verified-but-unavailable*
  and **passes** — shredding is a feature, and the log still proves what was sent;
- a source that **changed** reports *drifted* and **fails**, because the alternative is
  replay quietly substituting today's note for the one actually sent.

## Install

```sh
npm install @chatpanel/events
```

Node ≥ 18. No dependencies. `node --test tests/*.test.js`.

## License

See [LICENSE](./LICENSE).
