# Why OpenCode lanes halt mid-task in AI agents (2026-11-20)

**Symptom:** with `opencode`, `opencode-go` or `opencode-zen`, an agent starts a task, runs a few tool rounds, then stops as if the turn were finished. **No error appears in the usage store.**

**Evidence base:** `/home/gin/.config/omnihilbras/usage.json` has 209 OpenCode records — 207 `success`, 2 `failure` (one auth, one rate limit), 206 of them `opencode-go`, 204 on `ocg/hy4-flash-free`, 2.8–106 s, `attempts: 1`, **no error code and no token counts**. They arrive in agent-loop clusters. A stopped agent and a completed agent are indistinguishable in that data, which is itself finding #7 below.

Two independent traces (gateway stream/tool-round path and agent request-shape path) converged on the same causes. The top two were then reproduced locally against the built dist. No provider request was made.

---

## 1. Tool names are rewritten on the wire but not in the allow-list — reproduced

This is the primary cause and it applies to all three lanes.

- `Kernel/Tools/src/gatewayTools.ts:36-50` folds a client's `Read`, `Glob`, `Grep` to lowercase `read`, `glob`, `grep` (these are gateway-injected tool names) before the request reaches an OpenCode adapter.
- `Kernel/API/src/core/service.ts:3719` builds the **call allow-list** from the names *before* that rewrite (`normalized.tools`).
- `validateToolCalls` (`Kernel/Tools/src/normalize.ts:160-162`) and `guardToolStream` (`Kernel/Tools/src/stream.ts:59-78`) check returned calls against that allow-list. A call to `read` is not in `[Read, Glob, …]` → dropped; `service.ts:3766-3770` then rewrites `finish_reason: tool_calls → stop`.

Local reproduction (`/tmp/repro-oc-tools.mjs`):

```
client declared: [ 'Read', 'Glob' ]
sent upstream : [ 'read', 'glob', 'grep' ]
provider calls read → accepted: 0 issues: [{"name":"read","reason":"the call names a tool the client did not declare"}]
```

The agent sees a normal finished turn containing no tool call, so its loop stops. The same bug drops every call to the gateway's injected `read`/`glob`/`grep` tools even when the client declared no tools — `declaredNames` is never updated with the injected names (`service.ts:3727-3741`).

**9router's answer:** an explicit sent→original rename map, retargeted `tool_choice` and replay history, and name restoration in SSE and JSON replies (`open-sse/utils/opencodeFingerprint.js:153-205`, `:232-279`, `:447-510`).

---

## 2. Free-tier replay drops assistant `tool_calls` — reproduced

All three gated paths rebuild the conversation with only `role`, `content`, `name` and `tool_call_id` — no `tool_calls` on assistant messages:

- Zen `Kernel/SDK/opencode-zen/adapter/index.ts:51-58`
- Go `Kernel/SDK/opencode-go/adapter/index.ts:52-59`
- Console free lane `Kernel/SDK/opencode-console/adapter/index.ts:548-552`

The ordinary OpenAI lane does send them (`opencode-zen/lib/openai-compatible.ts:404-413`), so this is specific to the free-tier contract.

Local reproduction (`/tmp/repro-oc-history.mjs`), sending `[user, assistant(toolCalls:[c1]), tool(toolCallId:c1)]`:

```
assistant message sent upstream: {"role":"assistant","content":""}
tool message sent upstream    : {"role":"tool","content":"{\"name\":\"demo\"}","tool_call_id":"c1"}
```

The upstream model receives a tool result with no preceding call. It answers prose with `finish_reason: stop`, which the gateway records as success. This matches the observed `opencode-go` agent-loop clusters exactly.

**9router's answer:** replay aliases are kept consistent with the fingerprint rename map (`opencodeFingerprint.js:252-279`).

---

## 3. Forced tool choice is promised by caps, refused by the free tier

- `Kernel/Tools/src/caps.ts:84` grants `required` to `opencode` and `opencode-go`; `normalize.ts:118-125` therefore allows it through.
- The free-tier adapters throw `NOT_SUPPORTED`: Zen `zen/adapter/index.ts:643-648`, Go `go/adapter/index.ts:650` ("OpenCode free models accept only tool_choice auto or none").
- `NOT_SUPPORTED` is terminal in routing/retry (`core/routing.ts:505`, `core/retry-policy.ts:155`), so no sibling connection rescues the turn.

Meanwhile the free-tier wire helper overwrites the caller's choice with `auto` (`zen-free-tier.ts:190-192`, used by all three). Because gateway tools are always injected, `hasCallerTools` is effectively always true, so a client that asked for `toolChoice: 'none'` is sent upstream with `auto` plus tool definitions — inviting a tool round the caller forbade.

**9router's answer:** demote a forced choice for affected models rather than refuse (`open-sse/executors/opencode.js:426-431`).

---

## 4. Zen/Go streaming is implemented only on the chat lane — verified

`zenLaneFor()` (`zen/adapter/index.ts:128-155`) routes `claude-*` to Anthropic Messages and `gpt-/grok-/muse-spark-*` to Responses. `streamChat()` throws for both:

```
NOT_SUPPORTED: Streaming is not implemented for OpenCode Zen models on the ${lane} lane.
```
(`zen/adapter/index.ts:543-552`, Go `:549-558`.)

An Anthropic SDK agent (always `stream: true`) pointed at `opz/claude-…` or `ocg/claude-…` dies at this point. Even on non-streaming messages/responses, the body builders never send `tools`/`tool_choice` and the reply parsers discard `tool_use`/`function_call` blocks (`zen/adapter/index.ts:198-209`, `:248-258`, `:290-326`), so a tool loop cannot start at all.

**9router's answer:** select the transport by the **client's wire format** against each model's `supportedFormats` and stream all three shapes (`registry/opencode-zen.js:28-39`, `executors/index.js:39-98`, `chatCore/streamingHandler.js:27-46`).

---

## 5. The Console local-service bridge flattens the tool loop

`localTurn()` passes only `flattenForService(request.messages)` to the service (`opencode-console/adapter/index.ts:394-409`, `:867-881`): assistant tool-call messages with `content: null` are skipped, tool results become `"Tool: …"` text, and `request.tools` is never sent. A service result with `finish: 'tool_calls'` is mapped to `finishReason: 'tool_calls'` with **no tool-call payload** (`:337-344`, `:473`) — the agent waits for a call that never arrives. The service session is deleted after every turn (`opencode-service.ts:472-474`), so a partial turn cannot resume.

A clean SSE EOF with no terminal event also breaks the read loop and returns partial text (`opencode-service.ts:401-403`, `:459-467`).

---

## 6. Session affinity changes on every tool round (Zen/Console)

`zenConversationSeed()` hashes **all** messages plus tool names (`zen-free-tier.ts:238-244`), so `x-opencode-session` changes each round; Zen and Console use it (`:167-175`, zen `:650`, console `:529,543`). Go's paid lane uses a stable first-user-turn key (`opencode-go/lib/identity.ts:5-15,32-40`). 9router uses one time-minted, stable canonical session with failure invalidation (`opencode.js:110-218,486-491,528-541`). Unstable affinity can change upstream caching/routing between rounds.

---

## 7. Why the usage store shows success

The chat SSE writer records `success` whenever the async iterator ends without throwing, with no check for a terminal `finish_reason`, tool rounds or output text (`routes/inference.ts:955-968`, `:998-1010`; `request-executor.ts:847-853`). It accumulates text only from **string** deltas (`:966`), but OpenCode adapters emit object deltas — which is why all 204 free-model records have no token counts. Timeouts cannot explain these records: TTFB (120 s), idle (360 s) and total (1,800 s) all throw and are recorded as failures (`config.ts:151-153`, `request-executor.ts:784-822`). The 106 s maximum here is below the TTFB limit anyway.

---

## Ranked fix plan (items 1–4 applied; see note below)

| # | Fix | Where |
|---|---|---|
| 1 | Keep a sent→original tool-name map and restore returned call names before the allow-list check; add the injected gateway names to `declared` | `gatewayTools.ts`, `service.ts:3719-3741`, `stream.ts` |
| 2 | Preserve assistant `tool_calls` in the gated conversation replay for Zen, Go and Console | the three `toGatedMessage` helpers |
| 3 | Align caps with the free-tier policy: demote forced choice to `auto` instead of terminal `NOT_SUPPORTED`, and keep `none` as `none` | `caps.ts`, `normalize.ts`, three adapters, `zen-free-tier.ts` |
| 4 | Stream the Messages/Responses lanes or, at minimum, return a non-terminal, actionable refusal before the first byte and carry tools through non-streaming replies | `zen`/`go` adapters |
| 5 | Send tools and real tool-call deltas through the Console local-service bridge, and require a terminal event before ending a turn | `opencode-console/adapter/index.ts`, `opencode-service.ts` |
| 6 | Record `success` only when a terminal finish is seen and the answer/tool round is complete; otherwise record an explicit incomplete outcome | `routes/inference.ts`, `request-executor.ts` |
| 7 | Use a stable session key per downstream identity across tool rounds (the Go lane already does) | `zen-free-tier.ts`, Console gated path |

Fixes 1–3 are small, testable and address the reproduced failures directly. Fix 6 is what makes any future recurrence visible in the usage store.


## Applied fixes (2026-11-21)

1. **Tool-name folding repaired**: `gatewayToolNameMap()` records wire→caller names, the allow-list accepts both spellings, and non-streaming replies and SSE deltas are renamed back before the agent sees them.
2. **Gated history repaired**: Zen, Go and the Console direct free lane replay assistant `tool_calls` next to the results they answer.
3. **Forced choice aligned**: `caps.ts` states `auto`/`none` for all three OpenCode ids, so the gateway refuses by name before a provider call instead of a terminal mid-request refusal.
4. **Console bridge scoped**: turns that declare tools use the native free lane; the local-service path never flattens an agent tool loop, and its text history now records calls and results explicitly.

Still open from the original plan: recording a `success` outcome without a terminal finish check (visibility only), and choosing a stable per-identity session key across tool rounds for Zen/Console (the Go lane is already stable; no runtime evidence tied the session key to a halt). Verified with `tests/opencode-tool-loop.test.js`, `pnpm verify` and e2e.

## Generic fixes (2026-11-21, `3.90.6`)

The same symptom was reported with providers other than OpenCode, so the causes above were re-traced across the gateway rather than only the three free lanes. Fixes shipped in this release:

1. **Tool-name folding is general, not OpenCode-only** (`gatewayToolNameMap`, `Kernel/Tools/src/gatewayTools.ts`). Any declared tool whose name is lowercased on the wire is now mapped back to the caller's spelling and accepted by the allow-list; a case collision between two declared tools is left alone rather than guessed. The earlier map handled only `glob`/`grep`/`read`.
2. **Per-provider adapters that dropped calls were repaired**: CodeBuddy and Qoder non-streaming `chat()` now aggregate streamed call deltas by index and report `tool_calls`; Qoder replays `tool_calls`/`tool_call_id`; Kiro's history uses `toolUses`/`toolResults` instead of flat text; the OpenCode Go and Zen Messages lanes emit `tool_use`/`tool_result` blocks and parse `tool_use` replies into real calls with a matching finish reason.
3. **Tool-history repair checks every result for an assistant turn**, not just the next message (`Kernel/Tools/src/toolHistory.ts`), so one result per call no longer produces duplicate empty answers.
4. **SSE writers carry terminal state**: `/v1/messages` maps a provider `length` finish to `max_tokens` and no longer emits a tool block named `tool` for a nameless call; `/v1/responses` emits `function_call_arguments.done` and `output_item.done` before `response.completed` and marks a truncated turn `incomplete`.
5. **A halt is now visible in usage data**: SSE success records carry `incomplete: true` when no terminal finish reason was observed (`usage-store.ts`, `inference.ts`, `gatewayClient.ts`, `LogsPage.tsx`). A stopped agent turn no longer looks identical to a completed one in `/v1/usage` or the dashboard.

Regression tests: `tests/opencode-tool-loop.test.js`, `tests/agent-tool-loop-adapters.test.js`, `Kernel/Tools/test/toolHistory.test.js`, `Kernel/API/test/usage-route.test.js`. Still open: stable session affinity for Zen/Console (no runtime evidence tying it to a halt).
