# Phase 6.1 — Audit: OmniHilbras against 9router's defect classes

**Read-only.** No production code changed. Verdict for every class is backed by a `file:line` and, where
the claim is behavioural, by a measurement.

**Source of the classes:** an audit of `/home/gin/work/9router` v0.5.85, which found four live defects in a
mature codebase. Two of them are the exact classes OmniHilbras spent v1.52.0–v1.56.0 eliminating, so the
question was never "is this project better" but "does OmniHilbras have the same bug".

| # | Class | Verdict |
| --- | --- | --- |
| 1 | Truncated stream reported as a complete answer | **CLEAN** |
| 2 | Dropped HTTP status making an error look like success | **NOT APPLICABLE** |
| 3 | Data files written with inherited umask | **CLEAN** — better than 9router's |
| 4 | Unbounded module-level cache | **1 DEFECT FOUND** (low severity, one confirmed growth path) |
| 5 | A regression gate that is quietly broken | **CLEAN** |

---

## Class 1 — a truncated stream presented as a complete answer

**Verdict: CLEAN.**

9router's version: `open-sse/utils/stream.js:383-493`. `flush()` passes a `null` chunk to the translator,
every translator except OpenAI-Responses returns nothing, no finish frame is emitted, and the stream still
closes cleanly while logging `status: "success"`. The client sees an orderly EOF after `"Hello wor"` with no
error and no `finish_reason`.

OmniHilbras writes the sentinel **after** the loop, not in a `finally`:

`apps/gateway/src/routes/inference.ts:110`
```ts
await writeStreamData(response, 'data: [DONE]\n\n', signal);
```

Measured against a provider that emits two chunks and then throws:

```
data: {...,"choices":[{"index":0,"delta":{"content":"Hello wor"},"finish_reason":null}]}
data: {...,"choices":[{"index":0,"delta":{"content":"Hello wor"},"finish_reason":null}]}
event: error
data: {"error":{"code":"INTERNAL_ERROR","message":"The gateway encountered an unexpected error."}}
```

```
ends with [DONE] : false
contains an error: true
```

A truncated stream is **not** presented as complete.

### The error code is truthful too, which was worth checking

`INTERNAL_ERROR` looks wrong at first glance — the cause was a provider dying, not a gateway fault. Measured
across four causes, through the real HTTP route:

| real cause | what the client is told |
| --- | --- |
| `ProviderError('RATE_LIMITED')` | `RATE_LIMITED` — "The provider rate limit was reached." |
| `ProviderError('PROVIDER_TIMEOUT')` | `PROVIDER_TIMEOUT` — "The provider request timed out." |
| untyped `Error('upstream socket closed')` | `INTERNAL_ERROR` — "unexpected error" |
| untyped `Error('failed for key sk-abc…')` | `INTERNAL_ERROR` — "unexpected error" |

A typed cause propagates with its real code. An **untyped** cause is deliberately generic, and that is the
correct choice rather than a defect: the fourth row proves the message never reaches the client, so a
provider error containing a key cannot leak it. Redaction and specificity are not in conflict here.

---

## Class 2 — a dropped HTTP status making an error look like a success

**Verdict: NOT APPLICABLE.**

9router rebuilds a `Response` in its Ollama-compat transform with only `headers` and no `status`, so the
status defaults to 200 and every error is delivered as a success with an empty completion
(`src/app/api/v1/api/chat/route.js:35`).

OmniHilbras has **no response-rebuilding transform at all**. There is not one `new Response(` in
`apps/gateway/src/` or `packages/omnihilbras-sdk/src/`; the gateway is Node-based and writes through
`sendJson(response, status, …)` / `response.writeHead(status, …)`, so the status is a required argument on
every path. There is no route that could drop it.

A related check that *did* pass: the v1.54.0 work. A gateway whose only connections are over their rate limit
answers **429** with `retryable: false`, and a *mixed* refusal is deliberately not 429 — asserted in
`apps/gateway/test/execution-correctness.test.js` ("a refusal with any reason other than a limit is never
reported as 429").

---

## Class 3 — data files written with inherited umask

**Verdict: CLEAN, and materially better than 9router's.**

9router's `data.sqlite` sits at mode `0644` holding live provider tokens while the secret files beside it are
correctly `0600`, because the writer passes no `mode` and inherits umask.

OmniHilbras writes every secret through one helper, `apps/gateway/src/secure-store.ts:19-40`:

- `ensureSecureDirectory` — `mkdir(..., { mode: 0o700 })` **then** `chmod(0o700)`, and refuses a symlinked
  directory (`:15-17`)
- `atomicWrite` — `open(temporaryPath, 'wx', 0o600)`, `handle.sync()`, `rename()`, then `chmod(0o600)` (`:28-36`)
- refuses to write through a symlinked file (`:25`)

Measured on a real filesystem, with this machine's umask at `0022`:

```
directory mode: 0700 | expected 0700
file mode     : 0600 | expected 0600
symlink refused: yes: Refusing to write through a symbolic link.
```

Verified for **every** write path in the gateway:

- `secure-store.ts:32` — inside `atomicWrite`, so mode `0o600` is already applied
- `connections.ts:583` — `writeFile(this.keyPath, …, { flag: 'wx', mode: 0o600 })`, explicit

The `chmod` after `rename` matters and is the part 9router is missing: `open(…, 'wx', 0o600)` sets the mode
subject to umask, and the explicit `chmod` makes it independent of that.

---

## Class 4 — unbounded module-level cache

**Verdict: one real defect, low severity, one confirmed growth path.**

Scanned all 63 source files for `new Map()` / `new Set()` — 41 allocations. 39 are bounded: request-scoped
locals (`seen`, `visited`, per-call parsing maps), stores keyed by *saved* connections that evict on delete
(`routing.ts` `windows` and `state` both call `.delete`), or bounded-by-construction registries
(`ProviderRegistry.adapters`, capped at adapter count).

Two looked unbounded. One did not:

- `routes/connections.ts:204` `seen` — a request-scoped local in a de-duplication loop. Not a leak.
- **`rate-limit-policy.ts:45` `waits` — DEFECT.**

### The defect

```ts
private readonly waits = new Map<string, number>();
```

`waits` records the wait each connection was last told to observe. The only write is
`rate-limit-policy.ts:109` (`this.waits.set(...)`). **Nothing anywhere deletes from it** — the sole Map
mutation in the file is a `set`.

Measured directly against the real class: 50,000 distinct connection ids → **50,000 retained entries**.

### What I had to establish before calling it a defect

The first measurement looked much worse than the reality, and the correction matters:

1. **Is it client-reachable?** 300 requests each naming a different nonexistent provider (`ghost-0`…
   `ghost-299`) returned **404 × 300**. `routing-engine.ts:119` calls `requireAdapter(providerId)` before the
   `unmanaged:` candidate is built, so an unregistered provider is rejected before `enforce()`. The
   `unmanaged:<id>` key space is bounded by **registered adapters**, not by anything a client says.
2. **So what *is* reachable?** Two paths, both narrow:
   - `unmanaged:<id>` — only for a provider with a registered adapter.
   - saved connection ids — and those grow when the operator creates connections and **never shrink when
     they delete them**.

Path 2 confirmed end-to-end through the real management routes (`PUT /v1/connections/:id`, then
`DELETE`): 100 connections created, 100 deleted, `connections remaining: 0`, and `waits` still holding an
entry for each.

### Severity, stated honestly

**Low.** Bounded by the number of connections an operator creates and deletes over the gateway's lifetime —
not by traffic, not by anything a remote caller controls. `routing.ts` prunes its sibling maps; this one does
not, which reads as an oversight rather than a decision. Each entry is a short string key and a number.

**Not** remotely exploitable: a caller cannot invent connection ids, and 50,000 ids are unreachable without
50,000 real connection create/delete cycles.

### The fix, when it is worth making

Prune on the same signal the sibling maps use — a connection no longer existing — rather than adding a TTL,
because a wait of `0` is meaningful state ("checked and free", per the comment at `rate-limit-policy.ts:36-42`)
and a TTL would erase a genuine wait and make a cooling-down connection look ready. That is precisely the
confusion the map exists to prevent, and it is why the obvious fix is the wrong one.

---

## Class 5 — a regression gate that is quietly broken

**Verdict: CLEAN.**

9router's `tests/__baseline__/verify-no-regression.mjs:17` derives each test key via `f.name.split("/app/")[1]`.
Every committed baseline path is `/Users/Working/router4/app/tests/...`, so on any checkout not under a path
containing `/app/` the key becomes `undefined :: <name>`, matches nothing, and **every failure is reported as
a regression**. It also needs a `results.json` that no script in the repo produces.

OmniHilbras's count guards were added in v1.55.0 (`tests/documentation-counts.test.js`) specifically to stop
numbers drifting in prose, and they are **path-independent and mutation-tested**: the guard reads the same
directory listing the guard under test reads, rather than shelling out or parsing a stored path.

Verified as part of this audit by the same mutation technique used when they were written — an added adapter
file and an added fixture both fail the guard, because they fail when the **repository** changes rather than
when the paragraph does. That is the property 9router's gate lacks.

Two of the guards *did* need correcting when written, both recorded in the v1.55.0 notes: `require` in an ESM
module, and `spawnSync('node --test')` inside a test file (Node refuses: *"run() is being called recursively
within a test file"*). Both were caught because the guard failed on itself before it could report anything
about the docs.

---

## What this audit did not cover

Stated so the verdict table is not read as broader than it is.

- **No dependency audit.** `npm audit` was not run; there is no lockfile in 9router and none needed here.
- **No fuzzing.** Classes 1–3 were verified by construction, targeted measurement and mutation, not by
  generating malformed provider traffic.
- **Classes 1–3 are verified on the paths exercised.** A status-dropping transform could be *added* later
  without any guard failing; the CLEAN verdicts are about today's code.
- **The frontend was not re-audited.** `tests/browser-storage.test.js`, `provider-card-honesty` and
  `marketing-claims` were re-run by `pnpm verify` but not re-examined for new gaps.

---

## Next: Phase 6.2

Unaffected by anything found here. The usage store is the real gap — measured, not assumed: OmniHilbras keeps
**no per-request record at all**, which is why `Usage` and `Request log` sit disabled and why `Overview` was
deleted rather than built.

Phase 6.1's one finding should be recorded as a task rather than fixed in passing, keeping the
one-fix-per-release discipline. It is not on the critical path and nothing about it is urgent.
