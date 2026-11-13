# ZCode (Start Plan) provider — full plan

Source of truth studied: `/home/gin/work/omnihilbras imp/ZCodeToAPI` (read-only reference).
This plan adds a first-party `zcode` provider to OmniHilbras.

## What the reference proved

- Endpoint: `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`
  — **Anthropic Messages shape**, not GLM's native API.
- Auth: a ZCode Start Plan JWT (`zcodejwttoken` in `~/.zcode/v2/credentials.json`, AES-GCM
  `enc:v1:<iv>.<tag>.<ct>`), sent as **both** `x-api-key` and `Authorization: Bearer`.
- Desktop-mimicry headers: `ZCode/3.14.4`, `X-Platform`, `X-ZCode-App-Version`, `x-zcode-session-type`,
  `x-query-id` (UUIDv7), `anthropic-version: 2023-06-01`, `anthropic-beta: mid-conversation-system-2026-04-07`.
- Body: the **stock template** (3 system blocks ≈7.8 KB, 34 tools, `max_tokens: 128000`), plus
  `model: GLM-5.3 | GLM-5.3-Flash`, `stream: true`, `thinking: {type:'enabled'}`,
  `output_config.effort: low|high|max`, and `metadata.user_id` = `{device_id, account_uuid, session_id}`.
- Hard constraint: a **custom system prompt returns 405 code 3012** ("unusual activity"). The stock
  system/tools must be preserved; only user messages and thinking level change.
- Models: `glm-5.3`, `glm-5.3-flash` (plus aliases/uppercase).
- Thinking: `low | high | max`; `xhigh`/`medium`/`minimal`/`none` map onto these.
- Quota: `GET /api/v1/zcode-plan/billing/balance`; claims via `billing/preview` + `billing/claim`.
- Optional CAPTCHA: `/api/v1/client/configs` reports whether model requests need an Aliyun
  `X-Aliyun-Captcha-Verify-Param`. **Unverified for this account** — must be tested live.
- The reference proxies flatten the conversation to one prompt and buffer the answer. That is a
  limitation of *their* proxy, not of the endpoint; this provider talks the endpoint natively.

## Phases

### Phase 1 — Identity and catalog
- Card in `src/data/providers.ts`: `id: 'zcode'`, `name: 'ZCode (Start Plan)'`,
  `group: 'api-key'` (the credential is a pasted access token, collected by the existing key dialog),
  `auth: 'Access token'`, `endpoint: 'https://zcode.z.ai'`, `initial: 'ZC'` (or a bundled mark),
  all measured fields as placeholders (`models: '—'`, etc.).
- `provider-slugs.ts`: `zcode: 'zc'` so model ids qualify as `zc/glm-5.3`.
- `providerOptions` derives the card automatically; no second copy.

### Phase 2 — Adapter package `Kernel/SDK/zcode-start-plan/`
- Vendored `lib/` from `Kernel/SDK/anthropic` (the repo's per-provider vendoring rule).
- `adapter/index.ts`:
  - `zcodeProviderId = 'zcode'`; `ZCODE = { origin, messagesPath, template }`.
  - Credential = the JWT; headers add desktop mimicry + `x-api-key` + `Authorization`.
  - `listModels()` returns the static GLM-5.3 / GLM-5.3-Flash catalog (the endpoint has no model list).
  - `chat()` / `streamChat()`: build the Anthropic body from the request, but
    **replace the client's system with the stock template's system blocks and tools**, keep the
    client's messages and tool results, set `output_config.effort` from `reasoningEffort`.
  - Real SSE streaming (text + tool_use + usage).
  - `healthCheck()` = one 1-token "Reply only OK." turn (the reference's own smoke test).
- `lib/startPlanTemplate.ts`: the stock `system` + `tools` extracted from
  `start_plan_request_template.json`, committed as a typed module (no 98 KB JSON file to copy at build).

### Phase 3 — Gateway registration
- `service.ts`: `.onDemand(zcodeProviderId, () => this.zcodeAdapter())` (needs the template and custom auth).
- `service.ts`: `zcodeAdapter()` memoized like `chatGptWebAdapter`.
- `config.ts`: no registry change (on-demand).
- `provider-family.ts`: none (it is Anthropic-shaped but a distinct account, like `claude-code`).

### Phase 4 — Credential path (standalone OAuth)
- Primary: ZCode's own OAuth server, the same `oauth/cli` flow the desktop app uses for a CLI.
  `POST /v1/oauth/zcode/start` mints it (the poll token stays in the gateway), the user signs in in
  any browser, and `GET /v1/oauth/zcode/session/:id` polls until `ready` with `data.token`
  (`zcodejwttoken`). No desktop app and no `zcode://` scheme handler are needed.
- The local `~/.zcode/v2` import (`zcode-local.ts`) and the paste routes remain as fallbacks for a
  machine that already has the app or a token from elsewhere.
- `credential-lifecycle`: map 401/403 to `AUTHENTICATION_FAILED` ("sign in to ZCode again").

### Phase 5 — Quota (optional)
- Map `GET /v1/connections/:id/quota` to ZCode's balance buckets, labelled with their entitlement period.

### Phase 6 — Tests
- Adapter contract: request shape, stock template preserved, auth headers, streaming, model mapping,
  effort mapping.
- `tests/new-provider-cards.test.js`: `zcode` resolves as a registered id; no near-miss collision.
- `tests/provider-cards.test.js`: card has an initial or a bundled mark; no measured placeholder claims.
- `tests/provider-options.test.js`: derived, not duplicated.
- `tests/no-secrets.test.js`: no token committed.

### Phase 7 — Docs and version
- `README.md`, `docs/SPEC-SDK.md`, `docs/architecture/` counts, `AGENTS.md` if a boundary changed.
- Version bump (new provider = minor).

### Phase 8 — Live verification (needs the user's token)
- `pnpm dev:gateway`, save the connection with the JWT, run `"Reply only OK."`.
- Record whether CAPTCHA is required. If it is, the provider is not viable headless and the card must
  say so rather than fail silently.
- Then a multi-turn + tool-use turn to confirm structured messages survive the stock template.

## Acceptance

- `zcode` appears in the providers page and the add dialog.
- A saved JWT serves a chat turn through `/v1/chat/completions` and streams.
- The stock template is preserved (no 405/3012).
- The only failing tests are the five pre-existing routing tests.