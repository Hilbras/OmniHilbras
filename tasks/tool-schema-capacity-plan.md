# Tool-schema capacity and honest tool-turn completion — 3.98.1

**Created:** 2026-11-23
**Baseline:** repository 3.98.0, installed global CLI 3.97.0
**Status:** Implemented in the working tree; version bump, tag, release and publish pending

## Why

Live `usage.json` records from 2026-11-23 show agent requests declaring 314–317 tool definitions while
the gateway forwarded only 17 and dropped 297–300, on 784 of the last 1000 records. The cause was a
hardcoded 32 KB cumulative tool-schema budget: definitions past the budget were discarded, the call
allow-list was built from the survivors, and a returned call naming a dropped tool was rejected and
rewritten from `finish_reason: "tool_calls"` to `"stop"`. The client received an ordinary final answer,
ended its tool loop mid-task, and the usage record claimed success.

The 9router reference has no cumulative tool-schema cap — it forwards every declared definition and
only normalizes per field — and explicitly moved away from the "stop + empty answer + logged success"
pattern in its finish-reason translation.

## Non-goals

Empty-delta finish chunks, Claude cloaking decoys, Responses output-item lifecycle, the four-round
local-tool cap, and the remaining red 9router scorecard rows. Client-side tool selection
(`OMNICODE_EXPERIMENTAL_TOOL_SELECT`) is the durable complement to a larger gateway budget; it is
documented, not changed here.

## Phases

### Phase 0 — Stabilize the tree *(prerequisite)*

Committed HEAD imported the Claude tool-cloaking functions from `@omnihilbras/tools` while the
implementation was untracked and the barrel did not export it, so a fresh checkout could not build.
Commit 60d25e2b adds only `Kernel/Tools/src/toolCloaking.ts` and the exports in
`Kernel/Tools/src/index.ts`. The cycle-6/7 capability work stays in the working tree for its own
minor release. The `v3.96.0` tag repair (moving it to `bcd6222d`, whose manifest says 3.96.0) is a
force-pushed tag and requires explicit confirmation before execution.

### Phase 1 — Configurable tool-schema budget

`MAX_SCHEMA_BYTES` remains the Tools package default; `normalizeToolsRequest()` takes an optional
`ToolNormalizeOptions.maxSchemaBytes` so the browser-safe package never reads `process.env`.
`loadGatewayConfig()` parses `OMNIHILBRAS_TOOL_SCHEMA_BYTES` (32 KiB–8 MiB, default 256 KiB) and
`createGatewayService()` passes it into `GatewayService`, which supplies it to normalization. A larger
budget forwards more definitions but costs input tokens on every turn; values near 1 MiB can exceed a
model's context window.

Acceptance: 315 well-formed definitions are all forwarded under the default; a single oversized schema
is still refused with a reason; the historical 32 KB behaviour is available by setting the knob.

### Phase 2 — Dropped calls are honest

A per-request `blockedCallNotes` count in `GatewayService` records calls rejected by
`validateToolCalls` and `guardToolStream`; `blockedCallsFor(scopeId)` exposes it to the routes without
widening the persisted `UsageRecord`. Every inference surface keeps the existing `stop` terminal state
but adds `gateway.tools: "call-dropped"` to the terminal body/chunk, and the usage record gets
`incomplete: true` when a call was dropped.

Acceptance: an undeclared or dropped call still produces no executable tool call, but the client is
told and the record is no longer an unqualified success.

### Phase 3 — Regression tests

`Kernel/Tools/test/tools.test.js` (tool-heavy request under a raised budget),
`Kernel/API/test/service.test.js` (env knob and bounds),
`Kernel/API/test/tool-contract.test.js` (blocked calls counted in chat and stream paths), and
`Kernel/API/test/usage-route.test.js` (blocked stream call → `call-dropped` note and `incomplete` record).

### Phase 4 — Ship

`pnpm verify`; update README, `docs/SPEC-SDK.md`, `docs/architecture/` and this plan; bump to 3.98.1
with `pnpm version:fix` and `pnpm version:check`; commit, tag `v3.98.1`, push to `origin/main`, release
on GitHub; publish from `cli/` and poll `npm view @hilbras/omnihilbras@3.98.1 version`; run
`pnpm release:audit`; upgrade the global install and restart the gateway. Verify from a fresh
`usage.json` that `forwarded/declared` rose from 17/315 and that a blocked-call turn carries
`incomplete: true`. A green CI is not evidence the fix is live in the installed CLI.
