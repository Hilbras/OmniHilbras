# OpenCode Console provider — full plan

Goal: make OmniHilbras' `opencode-console` provider serve turns the way the OpenCode desktop
app does, or fail with the Console's own reason instead of a generic provider error.

## What is already established

- **Device flow** (`packages/core/src/plugin/provider/opencode.ts`): server `https://opencode.ai/console`,
  `client_id "opencode-cli"`, `POST /auth/device/code {client_id, supports_org_scope:true}`,
  poll `/auth/device/token {grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code, client_id}`,
  refresh with `grant_type:"refresh_token"`. Pending = `400 {"error":"authorization_pending"}`.
- **Credential**: `{type, methodID, refresh, access, expires, metadata:{server, accountID, email, orgID, orgName}}`.
- **Console API auth**: `authorization: Bearer <access>` + `x-org-id: <org>`.
- **Inference lane** from `GET /api/v2/config`: `provider.opencode.api = https://opencode.ai/inference/openai/v1`,
  header `x-opencode-org-id: <org>`. Paid models come back `disabled: true` for this plan.
- **Per-request client headers** (`packages/core/src/session/model-request.ts`):
  `x-opencode-session-id`, `x-session-affinity`, `X-Session-Id`, `x-opencode-session`,
  `x-opencode-project`, `x-opencode-client: opencode`, `User-Agent: opencode/<channel>/<version>/<name>`.
  Affinity = the session id itself (`packages/core/src/session/affinity.ts`).
- **Observed failure for a direct request** (same machine, same credential, seconds apart from a
  successful client run): free models → `429 FreeUsageLimitError`; paid → `402 Insufficient balance`.
  The app's own client (`opencode run --model opencode/deepseek-v4.1-flash-free`) succeeds.
- **Inference, not observation**: the server distinguishes the client, probably at the transport/HTTP
  fingerprint level. `--log-level trace` does not log upstream headers, the runtime ignores
  `HTTPS_PROXY`, and `tshark` is absent, so no capture has proved it yet.

## Phases

### Phase 1 — Surface the Console's own reason (no client needed)
- Map Console error bodies to a ProviderError whose **public message** is the server's text, so the
  dashboard and an agent app see `Free models work in OpenCode … subscribe to OpenCode Go` and
  `Insufficient balance. Top up at …/billing` instead of `PROVIDER_REQUEST_FAILED`.
- Add a **Console entitlement read** (`GET /api/v2/config` with the credential) exposed through the
  provider card's quota surface: plan, disabled models, billing URL.

### Phase 2 — Prove or disprove the fingerprint hypothesis (outcome: blocked by tooling, narrowed)

- **Narrowed, not proven.** A **Bun** script — the same runtime the client uses — sending the same
  credential, endpoint and header set answers `429 FreeUsageLimitError` exactly like Node's fetch. So
  the gate is **not** the runtime's TLS/HTTP fingerprint; it is something in the request the client
  sends that this machine has not let us observe.
- Capture routes tried and why each is closed here:
  - `tcpdump` exists but `sudo` requires interactive authentication, so no loopback capture.
  - The runtime ignored `HTTPS_PROXY`/`HTTP_PROXY` (a MITM proxy with a generated CA on `127.0.0.1:8899`
    captured 0 bytes while the CLI succeeded), so no proxy capture.
  - `--log-level trace --print-logs` does not log upstream headers.
  - The source checkout has no `node_modules` and no `packages/opencode/src/index.ts`, so the CLI
    cannot be run from source with an instrumented `fetch`.
- Remaining capture options: install `tshark`, set `SSLKEYLOGFILE`, and capture with a privileged
  `tcpdump` (needs the user's sudo); or patch the source checkout and run it after `bun install`.

### Phase 3 — Use the client's own transport (reconnaissance done)

The desktop app and CLI talk to a **local OpenCode service**, not to `opencode.ai` directly. That
service is the transport that qualifies for the free tier.

- Registration: `~/.local/state/opencode/service.json` → `{id, version, url, pid, password}`;
  a second file `~/.config/opencode/service.json` holds `{password}` only.
- Auth: **HTTP Basic**, username `opencode`, password from the registration file
  (`opencode:<password>` → 200/404; any other username or `Bearer` → `401 Authentication required`).
- Surface observed on a running service (`http://127.0.0.1:<port>`, here `49374`):
  - `GET /api/session` → 200, the OpenCode sessions (id, projectID, …)
  - `GET /api/project` → 200, the projects
  - `GET /api/config` → 200, a file listing of the config directory
  - `GET /api/event` → SSE stream (never returns)
  - `/api/health`, `/api/models`, `/v1/chat/completions` → 404/405: **there is no OpenAI-compatible
    chat endpoint** on the service.
- Consequence for the bridge: it must drive a **session** (create a session, send the user's message,
  read the assistant's reply and any tool calls) rather than post a chat completion. That is a real
  piece of work, and it makes the provider depend on OpenCode being installed and running — which the
  card must say.

### Phase 3 — Done

- `Kernel/API/src/core/opencode-service.ts` — discovery from `~/.local/state/opencode/service.json`,
  Basic auth, the session flow (`POST /api/session` → `POST /api/session/:id/prompt` →
  `POST /api/experimental/session/:id/wait` → `GET /api/session/:id/message` → `DELETE`), the answer
  read out of the assistant message's `content` blocks including reasoning, and
  `OpencodeServiceUnavailableError` when the service is not running. Four tests in
  `Kernel/API/test/opencode-service.test.js`.
- `Kernel/SDK/opencode-console/adapter/index.ts` — a `localService` hook used by `chat` and
  `streamChat` **before** the direct lane; a turn that fails mid-way is reported, only "not running"
  falls through. The gateway strips the provider prefix, so the adapter rebuilds the reference the
  service wants (`opc/deepseek-v4.1-flash-free` → `opencode/deepseek-v4.1-flash-free`) — without this
  the service answered `"deepseek-v4.1-flash-free" is not a provider/model reference`. Three tests.
- `Kernel/SDK/opencode-console/lib/types.ts` — `reasoning` on a `ChatChunk` delta, so a turn that
  spent its budget thinking is not delivered as an empty answer.
- **Result, measured:** `chatWithFailover` served

  ```
  opc/deepseek-v4.1-flash-free: OK -> "OK" | provider opencode-console
  opc/glm-5.3: OK -> ""            (a thinking-only turn; empty content is correct)
  ```

  A free Console turn is served through the gateway while the service runs; with the service stopped
  the same call reports the Console's refusal instead of a generic failure.

### Phase 4 — Docs, tests, version (done)

- `docs/SPEC-SDK.md` — "The free tier is served through the OpenCode app's own service": the measured
  refusal, the service's surface, the fallback rule, the prefix rebuild, and the dependency.
- `AGENTS.md` — the boundary: what the provider needs, and the two rules that are easy to get wrong.
- Suites: repo 277 (273 pass, 4 skipped, 0 fail), SDK 858/858, gateway unchanged apart from the five
  pre-existing routing failures. Version 3.31.0.

## Acceptance

- A `opc/deepseek-v4.1-flash-free` turn succeeds **through our gateway** — met, while the OpenCode
  service runs; and
- with the service stopped the provider reports the Console's exact refusal
  (`FreeUsageLimitError` / `Insufficient balance` with the billing URL) rather than
  `PROVIDER_REQUEST_FAILED` — met.
- `pnpm test` (repo + SDK + gateway) passes apart from the five pre-existing routing failures.
### Phase 5 — Streaming, thinking, and the tool boundary (done)

Measured from a client: `Retrying (2/10) · APIStatusError 504 The provider request timed out.`, no
streaming, no thinking.

- **The 504 was ours.** The bridge drove `/api/experimental/session/:id/wait`, which answers when the
  whole turn is over; the adapter then yielded that answer as one delta. The gateway's first-byte
  deadline is 120 s, a free model takes longer, so the client gave up first.
- **Fix:** subscribe to `GET /api/event` (SSE) *before* the prompt, forward `session.text.delta` and
  `session.reasoning.delta` as chunks, stop on `session.execution.succeeded` / `.failed`, and read the
  stored message afterwards for `model`, `finish`, and any delta the subscription missed. Reasoning
  deltas ride out as `reasoning_content`.
- **Measured through the gateway:** first byte 2.7–5.3 s, four SSE chunks, assembled answer exact.
- **The session is an agent with tools.** A prompt asking for a directory listing ran the shell and
  answered ``Contents of `/home/gin` (108 entries)`` — a gateway key was a file reader and a shell.
  The gateway now creates the session with `shell`, `edit`, `write`, `patch`, `webfetch`, `websearch`,
  `task`, `subagent`, `browser` denied; `read`/`grep`/`glob` stay so a coding agent can answer about a
  file it was handed. `OMNIHILBRAS_OPENCODE_SERVICE_TOOLS=all` opts back into the agent's own ruleset.
  **Read exposure remains** — a model that can read can read anything the gateway user can.
- **Not verified after the change:** the free tier's quota was exhausted by the verification runs
  themselves (`provider.quota`, retry after ≈ 14 h), so the deny-by-default ruleset has been exercised
  against a scripted service in tests, not against a live turn.


### Phase 6 — An allow list instead of a deny list, and one thinking block (done)

- **Tools.** The ruleset is now `*: deny` followed by `read`, `grep`, `glob`: an allow list by
  construction, so `question`, a goal or to-do tool, or an MCP tool this code cannot name is denied
  without an edit. **Measured:** denying *everything* makes the Console refuse the turn with
  `Free usage limit reached` — the request stops carrying the tool-carrying shape the free tier is
  granted to — so the read-only trio is also what keeps the turn admissible.
- **Thinking order.** Live event capture: `reasoning.delta` … `text.started` … `text.delta` ×18 …
  `reasoning.ended` — parts are concurrent and their end events do not follow their deltas. The bridge
  forwards reasoning only until the first text delta, so a client shows one thinking block and then the
  answer instead of reopening thinking between content. Verified live: delta pattern `TC` for both a
  plain and a tool-tempting prompt.
- **Service failures are readable.** `session.execution.failed` carries `error` as an object; the
  bridge read only the string form, so the Console's own sentence was replaced by
  "The OpenCode service failed the turn." — the one line worth having.
