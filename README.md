# OmniHilbras

A landing page for **OmniHilbras**, an intelligent, self-hostable AI gateway.

The first slice focuses on the product story and visual language: a warm editorial
surface, gold routing accents, a live gateway preview, and a responsive light/dark
theme inspired by the Hilbras Code design system.

The local dashboard is one React Router app mounted at `/dashboard`:

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

## Scripts

```bash
pnpm install
pnpm dev
pnpm dev:gateway
pnpm build
pnpm typecheck
pnpm test:sdk
pnpm test:gateway
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
