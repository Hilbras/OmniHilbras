# OmniHilbras

A self-hosted, local-first AI gateway: one OpenAI-compatible endpoint in front of
every provider, with API keys, routing, and per-connection reliability.

**Current version: 0.2.0** · [GitHub](https://github.com/Hilbras/OmniHilbras) ·
[npm](https://www.npmjs.com/package/@hilbras/omnihilbras)

```bash
npm i @hilbras/omnihilbras
```

The dashboard is one React Router app mounted at `/dashboard`:

- `/dashboard/overview`
- `/dashboard/providers`
- `/dashboard/providers/:providerId`
- `/dashboard/routing`
- `/dashboard/keys`

Navigation is client-side, so switching views never reloads the document. The
marketing page stays at `/`. A static host must send every `/dashboard/*` request
to `dashboard.html`; `public/_redirects` covers Netlify and Cloudflare Pages, and
the equivalent rule for other servers is:

```nginx
location /dashboard { try_files $uri /dashboard.html; }
```

All dashboard surfaces use the local gateway when it is running. OpenRouter is the
first provider with a live connection flow: the dashboard sends a candidate key
only to the loopback gateway, which validates it against OpenRouter and stores it
in an encrypted local vault. The connection dialog also lets you choose whether
Save imports free models or all text models; model IDs are persisted separately
from the credential. Any other provider can be added with a base URL through
`PUT /v1/connections/:id`.

The providers page groups cards as **OAuth Providers**, **API Key Providers**,
**Hosted API Providers**, **Free Tier Providers**, **Local Providers**, and
**Custom Endpoints**. A card is catalog metadata: it shows `—` metrics and
`No connections` until a real connection exists behind it.

## Searching Models

**On a provider page**, a search box sits directly above the model list. It matches
the full model ID and the name after the vendor prefix, so `claude-sonnet` finds
`anthropic/claude-sonnet-5` in a list of 458. The header shows how many of the
total are listed, and **Test all** tests what you are looking at — the button
reads `Test 8 shown` when a filter is active — rather than the whole catalog.

Beside it, a result filter narrows the list to **All / Untested / Passed /
Failed** with a count on each, and a sort orders by name, fastest, or slowest.
Untested models sort last, since they have no latency to compare.

**On the providers page**, the same search also spans providers. It reports which
providers serve a model and says whether each is actually serving it — `serving`,
`saved · needs attention`, or `not connected`. A saved connection is never shown
as "not connected", because that hides a credential you have actually saved.

Only imported models are searchable, so connect a provider first.

## Why a Model Can Fail Here And Work Elsewhere

A model test is one small real request, and several things can make that request
fail for reasons that have nothing to do with the model being broken.

**Reasoning models.** This was a real bug with two separate halves, both fixed.

The test originally asked for at most 16 tokens. Reasoning models spend their budget
on chain-of-thought before answering, so they returned `finish_reason: length` with
**no content at all** — and the test only checked that the envelope was well formed,
so it recorded a green `Ping` badge for a model that had answered nothing. The budget
is now 1024 tokens. Cost is bounded by what a model actually generates, not by the
cap.

The bigger half: **a reasoning-only reply is a working connection.** A model that
spends its whole budget thinking and emits no text has still proved it works. That
was being reported as a failure, which is why such models looked broken here and
behaved in other clients. When the content is empty but the response carries
reasoning — under `reasoning`, `reasoning_content`, `thinking`, or
`thinking_content` — the test now passes and the row is labelled `reasoning only`.

Measured on the free tier: three models that failed or returned nothing at a
96-token budget answer cleanly at 1024, and
`nvidia/nemotron-3-nano-omni-...-reasoning` succeeds on 4 of 5 requests, failing only
when the provider omits `choices` entirely.

**Free-tier rate limits.** A `:free` model answers `429` when the shared free quota
is spent, which is a provider limit and not a fault in the gateway.

**Providers that do not speak one API shape.** OpenCode Zen routes different models
to different endpoints: GPT models from `/zen/v1/responses`, some others from
`/zen/v1/messages`, the rest from `/zen/v1/chat/completions`. The gateway speaks
the last of those, so a model on either of the other two shapes fails here and
works in OpenCode. Choosing a path per model is not implemented.

**Account state, or model access.** Cline answers `402 Payment Required` when the
account has no credits. OpenCode Zen answers a bare `403` with an empty body for
some individual models: from one key on the correct endpoint, `space-bunny-free`
answers while `nemotron-3-ultra-free`, `mimo-v2.6-flash-free` and
`ling-3.0-flash-fin-free` are all refused — and Zen lists every one of them as
free. Zen documents that admins can disable individual models for a workspace, and
its Nemotron free models are NVIDIA trial endpoints. That refusal happens at the
provider and is not something this gateway can change.

When a provider refuses without saying why, the dashboard says so explicitly —
`HTTP 403 with an empty response body` — rather than showing nothing.

When a test fails, the failure reason is shown on the row. The result filter's
**Failed** tab isolates them, and a bulk run reports the count.

## Several Connections Per Provider

A provider can hold more than one connection — two Cline accounts, a spare
OpenRouter key. Each has its own credential, stored encrypted and keyed by
connection rather than by provider, so adding a second never disturbs the first.

`PUT /v1/connections/:providerId` updates that provider's existing connection.
Pass an `id` in the body to add another one alongside it:

```bash
curl -X PUT http://127.0.0.1:8787/v1/connections/opencode \
  -H 'content-type: application/json' \
  -d '{"id":"opencode-backup","apiKey":"...","name":"Backup account","endpoint":"https://opencode.ai/zen/v1"}'
```

Health is reported per provider rather than per connection, so a page shows one
health figure for a provider even when it has several connections.

## OpenCode Zen

OpenCode Zen is a hosted gateway from the OpenCode team. Get a key at
`opencode.ai/auth`, then add **OpenCode Zen** from its provider page. The gateway
serves it through the generic OpenAI-compatible path at
`https://opencode.ai/zen/v1`, and the model catalog imports without a credential
because OpenCode publishes it.

Zen routes different models to different API shapes, and the gateway picks the right
one per model: `/zen/v1/responses` for GPT, Grok and Muse; `/zen/v1/messages` for
Claude and Qwen; `/zen/v1/chat/completions` for the rest. Two shapes are not
implemented and are refused by name — Gemini, which Zen serves from its own path,
and Jev, a decision model.

Two things to expect. **Paid models need credits** — Zen charges per request, and
without a balance they answer `402`. **Free models are restricted to the OpenCode
client** and answer `403`; OpenCode's own words are "OpenCode's free tier can only be
used from within OpenCode". That restriction is not a header or a key or a stream
setting — it survives every one of them. Of the **11 free models in the catalog, one
answers: `space-bunny-free`.**

Zen also returns an empty body to a caller holding a key and a real explanation to one
that is not, so a refusal in the dashboard reads as a bare status code. Re-issue the
request unauthenticated to see what Zen actually said.

## Cline Sign-In

Cline is reached through an OAuth authorization-code flow instead of a pasted API
key. On its provider page, **Add connection** opens the sign-in in your browser
and waits there — there is normally nothing to paste.

The gateway starts the sign-in and hands back a session. Cline redirects the
browser to `GET /v1/oauth/cline/callback/:sessionId` on the gateway's own loopback
address, where the gateway exchanges the code, proves the token against Cline with
a real request, imports the model catalog, and saves the connection encrypted in
the local vault. The dashboard learns the outcome by polling
`GET /v1/oauth/cline/session/:id`, so the flow finishes on its own.

The session id rides in the redirect path rather than in an OAuth `state`,
because Cline's sign-in is handed to WorkOS AuthKit, which never echoes a
caller-supplied `state` back. A session is used once, so a replayed or forged
callback cannot put a code into your vault.

An expired access token is renewed automatically before use, and the renewed
token is written back to the vault. If a sign-in cannot be renewed, the provider
tells you to sign in again instead of failing quietly.

A paste field is still available in the same dialog for the case where the
provider does not hand the code to a browser redirect. It accepts a callback URL,
a `code#state` pair, or a bare code, and takes the same route to a saved
connection.

Cline serves its API under `https://api.cline.bot/api/v1`, and its model catalog
is public while `/api/v1/users/me` is the endpoint that actually checks a token —
so a sign-in is proved against the account endpoint and the catalog is only ever
read. If a sign-in is refused, the callback page reports what Cline said.

## Releases

The version tracks the size of the change. Every release is tagged on GitHub and
published to npm as `@hilbras/omnihilbras`.

| Change | Bump | Example |
| --- | --- | --- |
| Big — breaking API, removed or renamed public surface, behavior a consumer must adapt to | `x.0.0` | `0.2.0` → `1.0.0` |
| Medium — new capability, route, option, or page; backward compatible | `0.x.0` | `0.2.0` → `0.3.0` |
| Small — fix, refinement, docs, or internal cleanup | `0.0.x` | `0.2.0` → `0.2.1` |

`@hilbras/omnihilbras` is this project. It is unrelated to `@hilbras/sdk`, which
is a separate package under the same npm scope.

## Scripts

```bash
pnpm install
pnpm dev
pnpm dev:gateway
pnpm build
pnpm typecheck
pnpm test
```

## Local Gateway

The first backend slice lives in `apps/gateway` and uses the shared SDK in
`packages/omnihilbras-sdk`.

```bash
pnpm dev:gateway
```

The local server binds to `127.0.0.1:8787` by default. Configure fallback
credentials through environment variables; they are read server-side and are
never logged. OpenRouter keys entered in the dashboard are validated by the
gateway through `GET https://openrouter.ai/api/v1/key` on both **Check** and
**Save**, then encrypted with AES-256-GCM in the local connection vault. The
browser never writes them to `localStorage` or sends them directly to
OpenRouter.

Connection metadata and encrypted credentials are stored separately under
`$XDG_CONFIG_HOME/omnihilbras` (or `~/.config/omnihilbras`) by default. Set
`OMNIHILBRAS_DATA_DIR` to choose another local directory. A generated local
key file is created with mode `0600`; set `OMNIHILBRAS_MASTER_KEY` to a strict
32-byte base64 or 64-character hex value for an externally managed key. The
local vault protects data at rest from casual disclosure, but a compromised
same-user process can access a locally stored key.

Local mode rejects non-loopback binds and wildcard CORS. The dashboard origins
allowed by default are `http://localhost:5173` and `http://127.0.0.1:5173`; add
an exact development origin with `OMNIHILBRAS_CORS_ORIGINS` when needed.

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
OMNIHILBRAS_COMPATIBLE_API_KEY=...
# Optional local connection settings:
OMNIHILBRAS_DATA_DIR=...
OMNIHILBRAS_MASTER_KEY=...
# Optional reliability tuning (per-connection budgets are set in the dashboard):
OMNIHILBRAS_HEALTH_INTERVAL_MS=60000
OMNIHILBRAS_FAILURE_THRESHOLD=3
OMNIHILBRAS_RECOVERY_COOLDOWN_MS=30000
# Optional custom OpenAI-compatible paths:
OMNIHILBRAS_COMPATIBLE_MODELS_PATH=/models
OMNIHILBRAS_COMPATIBLE_CHAT_PATH=/chat/completions
```

Available routes:

- `GET /health`
- `GET /v1/models`
- `GET /v1/connections`
- `POST /v1/connections/openrouter/check`
- `PUT /v1/connections/openrouter`
- `POST /v1/connections/:id/models`
- `DELETE /v1/connections/:id`
- `PUT /v1/connections/:id/resilience`
- `GET /v1/routing`
- `GET /v1/keys`
- `POST /v1/keys`
- `PATCH /v1/keys/:id`
- `DELETE /v1/keys/:id`
- `PUT /v1/settings/require-api-key`
- `POST /v1/chat/completions`
- `POST /v1/chat/completions` with `stream: true` for SSE

## API Keys

The **API keys** dashboard page issues keys for clients that call this gateway
(CLI tools, IDE extensions, scripts). Each key is shown exactly once in the
create dialog; the gateway keeps only a SHA-256 hash in
`$XDG_CONFIG_HOME/omnihilbras/api-keys.json` (mode `0600`), so a key cannot be
displayed again and a lost key must be replaced.

```bash
# create a key (the response contains the only copy of the secret)
curl -X POST http://127.0.0.1:8787/v1/keys \
  -H 'content-type: application/json' \
  -d '{"name":"CLI tools"}'

# call the gateway
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer ohk_..."
```

Keys are accepted as `Authorization: Bearer <key>`, `x-api-key: <key>`, or
`x-goog-api-key: <key>` so existing OpenAI, Anthropic, and Gemini clients work
unchanged. They are never read from the query string.

### Pointing a code agent at the gateway

A client needs three values and nothing else: the base URL, the key, and a model
ID. Point the agent at `http://127.0.0.1:8787/v1`, paste the key as its API key,
and pick any model from `GET /v1/models`.

The model list is the saved connection catalog, not the provider's full
inventory, so agents only see models you actually imported (your 21 free
OpenRouter models, for example) and never a paid model you did not choose.
Requests are routed to the connection that owns the requested model, so no
provider header is required. `x-omnihilbras-provider: <id>` still overrides that
choice when you want to pin a route.

`POST /v1/chat/completions` accepts `stream: true` and OpenAI-style `tools`, so
streaming and tool-calling agents work. `/v1/models` needs the key while
enforcement is on.

Enforcement is **on by default** and applies to `GET /v1/models` and
`POST /v1/chat/completions`. Requests from an allowlisted dashboard origin stay
exempt so the dashboard can keep testing models; every other client must present
a valid, unpaused key. The toggle on the API keys page, or
`PUT /v1/settings/require-api-key`, turns enforcement off. Pausing or deleting
a key takes effect on the next request.

## Connection Reliability

Each connection carries its own retry, timeout, rate-limit, and hedge budget,
editable under **Reliability** on the provider page or through
`PUT /v1/connections/:id/resilience`:

```json
{ "maxRetries": 2, "timeoutMs": 25000, "requestsPerMinute": 60, "hedgeAfterMs": 400 }
```

- **`maxRetries`** (0–5, default 1) — extra attempts on the same connection.
- **`timeoutMs`** (0–600000, default 0 = shared default) — per-request deadline,
  enforced by the gateway so a provider that ignores cancellation still cannot
  hang a request.
- **`requestsPerMinute`** (0–100000, default 0 = unlimited) — sliding window per
  connection. Exceeding it hands the request to the next route.
- **`hedgeAfterMs`** (0–30000, default 0 = off) — if this connection has not
  answered in time, the next eligible connection is raced against it and the
  first reply wins. The loser is cancelled, so its tokens are normally not
  billed. Nothing is sent when no other connection can serve the model, so a
  single connection never pays the extra cost.

A retryable failure (timeout, rate limit, provider unavailable) spends the retry
budget, then falls through to the next connection by priority. Auth failures and
invalid requests are never retried — repeating them cannot help. Streaming
fails over only before the first chunk is sent; a mid-stream failure is reported
rather than silently restarting.

Measured on a deliberately slow local endpoint racing OpenRouter, with hedging
off the request took 2550 ms, and with a 400 ms hedge it took 1267–1773 ms and
was served by OpenRouter while the slow route was cancelled.

After `OMNIHILBRAS_FAILURE_THRESHOLD` consecutive failures (default 3) a
connection is ejected from routing. It rejoins automatically after a 30 second
cooldown, so a recovered provider returns without a restart. Background health
polling (`OMNIHILBRAS_HEALTH_INTERVAL_MS`, default 60000) marks unhealthy
providers independently of live traffic.

When failover actually engages, a non-streaming response carries the attempt
trace so a client can see what happened:

```json
"gateway": { "attempts": [
  { "provider": "openrouter", "attempt": 1, "ok": false, "error": "PROVIDER_TIMEOUT" },
  { "provider": "backup", "attempt": 1, "ok": true, "latencyMs": 812 }
] }
```

`GET /v1/routing` reports live state: per-connection budgets, recent failures
and successes, ejection, last latency, and the last error.

OpenRouter model import is controlled by the dialog toggle and defaults to
free mode when an API client omits the policy. Free mode keeps only discovered
models whose OpenRouter `pricing.prompt` and
`pricing.completion` values are zero; disabled mode imports all text models
returned by OpenRouter. Manually added model IDs are tracked separately and
remain in the catalog when the connection is re-saved with either policy. The
model endpoint accepts validated model IDs for adding custom entries later.

Provider **Test provider** checks live adapter health through `GET /health`. Each
model **Test** button sends one real, bounded chat completion through
`POST /v1/chat/completions` using the saved gateway credential. The test prompt
is fixed and limited to 16 output tokens, but it can still consume provider
quota or credits.

Use the `x-omnihilbras-provider` header to select a configured provider, for
example `x-omnihilbras-provider: anthropic`.
