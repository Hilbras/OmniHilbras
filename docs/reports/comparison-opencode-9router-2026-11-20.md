# OpenCode lanes: OmniHilbras vs 9router (2026-11-20)

**Scope:** the OpenCode Go / Zen / Console lanes and the local `opencode serve --service` bridge in both trees. Both were read end-to-end by two independent investigations, then the load-bearing claims were re-verified directly against source. OmniHilbras at `9981a729` (v3.87.2); 9router at `1855aa44` (v0.5.119). No files in either project were modified by the investigation, and no provider request was made.

---

## 1. The trap: the same provider ids mean different things

This is the first thing to know before comparing anything.

| Name in this project | Meaning here | Name in 9router | Meaning there |
| --- | --- | --- | --- |
| `opencode` (slug `opz`, legacy `opencode-zen`) | **Zen, keyed** — `https://opencode.ai/zen/v1`, API key or OAuth device flow | `opencode` (alias `oc`) | **Free, no-auth** — `https://opencode.ai/inference/v1`, always `Bearer public` |
| `opencode-go` (slug `ocg`) | Go, keyed — `https://opencode.ai/zen/go/v1`, same OAuth/API-key choices | `opencode-go` (alias `ocg`) | Go, keyed — `https://opencode.ai/inference/go/...`, API key only |
| `opencode-console` (slug `opc`) | Console — `console.opencode.ai` device flow, and the **only** lane with a local service bridge | — | **No such lane** |
| — | — | `opencode-zen` (alias `ocz`) | Zen, keyed — `https://opencode.ai/zen/v1`, API key only |

Sources: our `Kernel/API/src/core/provider-slugs.ts:29-95` and `:103-108`, registrations at `Kernel/API/src/core/service.ts:715-732`; 9router registry files `open-sse/providers/registry/opencode.js:1-55`, `opencode-go.js:1-102`, `opencode-zen.js:1-134`.

**`opencode-zen` is not a live provider id in our gateway** — it survives only as the SDK directory name (`Kernel/SDK/opencode-zen/`) and a legacy prefix. In 9router it is a first-class provider. So a model id like `opencode-zen/foo` routes to Zen in both projects, but the surrounding auth and free-tier machinery is entirely different.

---

## 2. Lane architecture at a glance

| Aspect | OmniHilbras | 9router |
| --- | --- | --- |
| Free model serving | Console free models are driven through a **locally started OpenCode agent** (`opencode serve --service`), with read-only permissions by default | Direct HTTPS to `/inference/v1`, with a frozen tool fingerprint, `<env>` marker, session affinity, and TLS ClientHello impersonation |
| Keyed Zen lane | One `ZenAdapter` with per-model lane selection (chat / messages / responses) and a free-tier contract for `-free` ids | `OpenCodeZenExecutor` with three registered transports selected by the client's wire format; `-free` ids switch to `Bearer public` |
| Keyed Go lane | Separate `OpenCodeGoAdapter`, mandatory `x-opencode-session` on **every** request, own `/zen/go/v1/usage` quota | `OpenCodeGoExecutor`, three transports selected by source format, API key only, no fingerprint |
| Console | First-class provider with device flow, workspace choice, token refresh | Absent |
| Local runtime install/start | Built in: `/v1/runtime/opencode`, `/install`, `/start`, supervisor, orphan adoption | Absent |
| Auth methods across OpenCode | OAuth device flow (Zen, Go, Console) + API key (Zen, Go) | API key only for Zen/Go; free lane has no auth by design |

---

## 3. Free tier: two completely different strategies

### OmniHilbras — drive a local OpenCode agent, confine it

The Console adapter takes a `localService` hook (`Kernel/SDK/opencode-console/adapter/index.ts:248-266`) supplied by the gateway (`Kernel/API/src/core/service.ts:2939-2955`). For a free turn it:

1. discovers `~/.local/state/opencode/service.json`, loopback URL plus password, Basic `opencode:<password>` (`opencode-service.ts:62-119`);
2. opens `GET /api/event` (SSE) **before** posting the prompt so no delta is lost, then `POST /api/session`, `POST /api/session/:id/prompt` (`:330-476`);
3. creates the session with a deny-all permission list and only `read`, `grep`, `glob` allowed back; `external_directory` is allowed unless `OMNIHILBRAS_OPENCODE_SERVICE_TOOLS=project` (`:257-264`, `:310-328`; verified in source);
4. forwards `session.text.delta` and `session.reasoning.delta` — but reasoning only until the first text delta (`:382-397`, `:430-436`);
5. fetches the stored message, deletes the session, and maps "free usage limit" to non-retryable `RATE_LIMITED` (`:179-202`, `:244-255`, `:459-475`).

If no service is running, the bridge throws `OpencodeServiceUnavailable` and the adapter falls back to the direct lane (`opencode-console/adapter/index.ts:395-409`, `:458-464`); a turn that already started is rethrown, never retried on the lane that gets refused. Since v3.51.0 the gateway can **start and even install** its own `opencode serve --service` (port 49390) and adopt an orphan whose cmdline and `XDG_STATE_HOME` both identify it (`opencode-runtime.ts:117-218`, `:345-447`, `:619-684`).

### 9router — impersonate the official client over the wire

9router's free lane is a remote client to `https://opencode.ai/inference/v1/chat/completions` (`:509-516`) with `Authorization: Bearer public` (`:532`), because `/zen/v1` now answers every free request with `403 FreeTierError` (`:509-510`). To pass the upstream gate it reproduces four things:

- **Frozen tool definitions**: exactly `read` and `shell`, with verbatim descriptions and parameter schemas from OpenCode CLI v2.0.26 (`open-sse/utils/opencodeFingerprint.js:24-66`). Upstream compares description and parameters; a stubbed description yields `403 FreeTierError`.
- **`<env>` system marker**: verbatim working directory / git-repo / platform block (`:311-400`). Missing marker or missing tools yields `429 FreeUsageLimitError` regardless of headers, UA or session.
- **Collision handling**: same-name caller tools that can carry the fingerprint definition are normalized in place; incompatible schemas are renamed and restored on the response; any declared tool name containing `terminal` is aliased to `run_command` (`:108-206`, `:26-34`).
- **Transport authenticity**: the gate keys on the TLS ClientHello, not just headers — Node fetch/https/http2 all got 429 while Bun's BoringSSL fetch got 200 on the same IP (`open-sse/services/opencodeTlsClient.js:1-12`). The implementation uses optional `wreq-js` with a JA4-matching cipher list (`:16-36`, `:68-148`), fail-open if unavailable.
- **Sessions and UA**: time-minted `ses_` sessions with stable reuse, v2 CLI UA `opencode/latest/2.0.26/cli`, five session headers, and an 8-attempt overload retry (800 ms base, 4 s cap) that distinguishes quota 429 from transient overload (`opencode.js:21-75`, `:38-65`, `:411-544`, `:478-506`).

**Trade-off:** our approach avoids TLS impersonation and won't inherit upstream fingerprint changes, but it depends on a local program (auto-installable, ~200 MB) and exposes read access to whatever the gateway user can read. 9router's approach needs no local program and follows upstream wire changes in code, but carries a much larger and more brittle emulation surface.

---

## 4. Go lane

Both projects give Go its own executor with a distinct base URL, rather than treating it as Zen with a different path.

| | OmniHilbras | 9router |
| --- | --- | --- |
| Base | `https://opencode.ai/zen/go/v1` | `https://opencode.ai/inference/go/{openai,anthropic}/v1` |
| Identity headers | `user-agent: opencode/1.18.31`, `x-opencode-client: desktop`, `x-opencode-project: global`, **`x-opencode-session`** derived from the first user turn + model, `x-opencode-request` — injected on **every** request type (`Kernel/SDK/opencode-go/lib/identity.ts:32-40`; pinned by `Kernel/API/test/opencode-go-wiring.test.js:23-46`) | `x-opencode-session` from a prepared credential field (`executors/opencode-go.js:145-156`) |
| Wire selection | Chat is OpenAI-compatible; messages/responses lanes merged into the same adapter (`opencode-go/adapter/index.ts:520-527`) | Three transports selected by the client's source format with a per-model guard; responses models force the responses URL (`:17`, `:118-122`) |
| Quota | `GET /zen/go/v1/usage`, rolling/weekly/monthly as used against limit 100 (`:389-419`) | `GET .../inference/go/v1/usage`, same percent mapping with `resetsAt` (`services/usage/opencode-go.js:1-107`) |
| Validation | `validateOnSave: true` (`service.ts:731`) | Live 1-token POST; non-401/403 counts as valid (`validate/route.js:446-458`) |
| Free tier on keyed lane | Go uses the same free-tier contract helper as Zen (session id + UA + declared tools) | No fingerprint; `-free` switching is a Zen behavior, not Go's |

**Notable:** 9router's CHANGELOG records that a bespoke Go executor was removed because its `_lastModel` cache could cross auth headers between concurrent requests (`:548-552`). Our Go adapter is a separate class with no such cache.

---

## 5. Zen lane

| | OmniHilbras | 9router |
| --- | --- | --- |
| Auth | API key or OAuth device flow saved as the connection credential (`service.ts:1334-1383`); messages lane uses raw `x-api-key` unless OAuth, then Bearer + `x-opencode-org-id` (`zen/adapter/index.ts:513-523`, `:765-787`) | API key only (no OpenCode OAuth in any registry entry) |
| Per-model lane choice | `zenLaneFor()`: `claude-*` and some Qwen ids → Anthropic Messages; `gpt-/grok-/muse-spark-` → Responses; `jev-*` / `gemini-*` refused as `NOT_SUPPORTED` (`zen/adapter/index.ts:128-163`) | Per-model `targetFormat`/`supportedFormats` tables plus regex family fallback (`registry/opencode-zen.js:37-119`, `models/helpers.js:51-66`) |
| `-free` ids on a keyed account | Free-tier contract applied, self-correcting retry if the model answers `FreeTierError` (`:487-505`) | Force `Authorization: Bearer public` + `x-opencode-request` (`executors/opencode-zen.js:285-292`) |
| Tool quartet for free | Shared frozen contract (session + UA + declared tools), from the gateway's single catalog (`zen-free-tier.ts`, `declaredTools()` at `zen/adapter/index.ts:73-77`) | Weaker quartet `bash, glob, grep, read` with generic descriptions, no `<env>` marker (`opencode-zen.js:21-23`, `:94-140`) |
| Quota | `GET /zen/v1/usage` (`:383-413`) | `GET /zen/v1/usage` with `resetsAt` (`services/usage/opencode-zen.js`) |
| Streaming | Chat lane only; messages/responses streaming refused by name (`:543-561`); gated stream reader at `:642-727` | Format-matched transports with full streaming transforms, fingerprint name restoration on passthrough (`streamingHandler.js:24-46`) |

---

## 6. Console lane — ours only

- Device flow: `client_id=opencode-cli, supports_org_scope:true` (`opencodeConsole.ts:177-199`); `authorization_pending` / `slow_down` handled; alphabetically-first org chosen, multiple workspaces park the token until the user chooses (`:213-280`, `service.ts:1789-1804`).
- Grant claimed once (`opencodeConsole.ts:86-92`); workspace id parsed from the callback, not accepted as a free-form field (`service.ts:1815-1817`).
- Refresh: `grant_type=refresh_token` at `/auth/device/token`, memoized per replaced token, written back to the vault by `onTokensRefreshed` (`opencode-console/adapter/index.ts:187-227`, `:691-719`, `service.ts:2927-2930`).
- Catalog read from `/api/config` plus best-effort `/api/v2/config` with `disabled` flags, cached 10 minutes; two distinct org headers — config wants `x-org-id`, inference wants `x-opencode-org-id` (`:732-786`, `:744-747`).
- Free models prefer the local service bridge; the direct `FREE_LANE` (`https://opencode.ai/zen/v1/chat/completions`) is used when the bridge is unavailable (`:70`, `:526-645`).
- Capability row: tools yes, forcing no (`Kernel/Tools/src/caps.ts:94`).

9router has no equivalent: no console provider, no console OAuth, no workspace selection, no local bridge.

---

## 7. Local runtime and process ownership

Our gateway can install, start, supervise and stop its own OpenCode service:

- install pins version `2.0.28`, records SHA-256, and **verifies an operator-supplied** `OMNIHILBRAS_OPENCODE_SHA256` (`:865-948`); upstream publishes no checksum, so this is an operator check, not an upstream one;
- `OMNIHILBRAS_OPENCODE_SERVICE = off | auto | install` (`:802-804`), default `auto` starts an existing binary;
- supervisor every 10 s, refuses to spawn into an occupied port, guards against duplicate concurrent starts (`:496-553`, `:671`, `:708-737`);
- orphan adoption requires **both** cmdline (`opencode`, `serve`, `--service`, our port) and exact `XDG_STATE_HOME` from `/proc` (`:345-447`); no `/proc` means no adoption;
- **it does stop its own verified instance** on shutdown: `stopOpencodeService()` SIGTERMs, polls 5 s, then SIGKILLs (`:749-783`, called from `main.ts:39-65`).

9router has no local service bridge at all. Its only local OpenCode integration is the reverse direction: writing a `provider["9router"]` stanza into an installed OpenCode CLI's settings so the CLI points at 9router (`src/app/api/cli-tools/opencode-settings/route.js:16-54,77-100`).

---

## 8. Errors, timeouts, cancellation

| | OmniHilbras | 9router |
| --- | --- | --- |
| Free-tier refusal | `RATE_LIMITED` not retryable for "free usage limit", `PROVIDER_REQUEST_FAILED` not retryable for "insufficient balance", provider sentence in `details.providerMessage` (`opencode-service.ts:244-255`) | `403` / non-overload `429` = session problem (no retry); overload `429` retried 8× with capped backoff; minted session dropped on non-retryable refusal (`opencode.js:38-65`, `:478-506`) |
| Generic 429 | connector cooldown + breaker, terminal vs retryable decided by one `RetryPolicy`; inbound rpm limiter is separate | generic config gives 429 **zero** retries (`runtimeConfig.js:120-143`); cooldown by text/status rules |
| First byte | TTFB deadline `ttfbMs ?? timeoutMs`, default 120 s (`config.ts:151`, `request-executor.ts:784-798`) | 60 s connect/header timeout, 360 s inter-chunk stall; the 200 s first-chunk constant is used only by Kiro (`runtimeConfig.js:51-64`) |
| Cancellation | caller signal relayed into the service; route records `cancelled`, never failure | single `streamController` with 499 on abort; post-200 abort emits a terminal SSE frame |

---

## 9. Documentation drift found in this pass

These are about **our** docs, not 9router's; each was checked against source:

1. `AGENTS.md:290-291` says "Nothing the gateway starts is ever killed." False since owned-instance shutdown: `stopOpencodeService()` (`opencode-runtime.ts:749-783`, `main.ts:39-65`). The intent that survives is narrower — a **borrowed/user** instance is never signalled.
2. `AGENTS.md:250` says a card or doc claiming this provider works with the OpenCode app closed is wrong. False since the installable/owned runtime (v3.36.0+/v3.51.0+); `AGENTS.md:284-285` itself says the bridge starts it on demand.
3. `AGENTS.md:288-289` says no upstream checksum is verified. Still true of upstream, but `OMNIHILBRAS_OPENCODE_SHA256` is a real enforced check (`opencode-runtime.ts:927-930`).
4. `AGENTS.md:300`'s "either half alone can be the user's own app on 49374" is imprecise — the cmdline half already includes our port, so a process on 49374 fails it outright (`:442-447`). Both halves are still required.
5. `AGENTS.md` has no description of the Go lane at all; its OpenCode section covers Console and the service bridge only.
6. Stale source comments: `service.ts:728-730` calls Go "the same adapter with a different base" (it is a separate class at `:2000-2010`); `opencode-service.ts:31-35` says the service is never spawned by the gateway.

The measured claims ("denying everything loses the turn", the `build` agent directory listing) are documented in `opencode-service.ts:297-308` and `docs/SPEC-SDK.md:1363-1378` but are not pinned by a runtime test — they are reports of measurements, not mechanisms.

---

## 10. What to borrow, what not to

**Worth considering from 9router:**
- Distinguish *quota 429* from *overload 429* in the free-lane path; our mapping currently makes all free-limit refusals non-retryable and relies on model cooldown.
- `resetsAt`-aware quota results so a cooldown ends when the provider says it does, rather than on a generic backoff curve.
- Per-model `targetFormat`/`supportedFormats` tables for OpenCode models, so a client's wire format picks the endpoint without adapter-side special cases (our `zenLaneFor()` is a smaller hand-written version).
- The in-place fingerprint-name normalization idea if we ever drop the local service bridge for free models.

**Do not borrow:** TLS ClientHello impersonation / JA4 cipher matching, frozen third-party tool descriptions that rot with upstream versions, or the textual `terminal` name gate. Those exist to satisfy an upstream anti-automation gate; reproducing them is brittle and the local-service approach avoids them entirely.

**Keep in OmniHilbras:** the local read-only agent with deny-by-default permissions, owned-runtime install/start with identity-checked adoption, no signalling of borrowed processes, per-connection quota API, OAuth + refresh with one-shot grants, and honest error wording when a lane cannot serve a model.

---

## 11. Verdict

The projects solve the same free-tier problem from opposite ends. 9router reconstructs the official OpenCode client on the wire (frozen tools, `<env>`, sessions, TLS fingerprint) and keeps all execution remote; OmniHilbras runs the real OpenCode agent locally with a deliberately narrow permission set and refuses to impersonate anything. 9router has richer keyed-lane transport selection and reset-aware quotas; OmniHilbras has Console auth, a local runtime, and a much smaller impersonation surface. The largest documentation risk is not either implementation — it is our stale `AGENTS.md` prose, which now contradicts the shipped owned-runtime behavior in five separate places.
