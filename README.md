# OmniHilbras

A landing page for **OmniHilbras**, an intelligent, self-hostable AI gateway.

The first slice focuses on the product story and visual language: a warm editorial
surface, gold routing accents, a live gateway preview, and a responsive light/dark
theme inspired by the Hilbras Code design system.

The local dashboard is a client-side app at `/dashboard.html`. Its routes are
hash-based so they work on any static host without server rewrites:

- `#/overview`
- `#/providers`
- `#/providers/:providerId`
- `#/routing`

The standalone HTML entry files remain available as direct-entry fallbacks, but
internal dashboard navigation no longer reloads the document. All dashboard
surfaces use the local gateway when it is running. OpenRouter is the first
provider with a live connection flow: the dashboard sends a candidate key only
to the loopback gateway, which validates it against OpenRouter and stores it in
an encrypted local vault. The connection dialog also lets you choose whether
Save imports free models or all text models; model IDs are persisted separately
from the credential. OpenRouter currently uses the single-slot Single Add
flow; other provider connection forms remain preview-only.

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
- `POST /v1/chat/completions`
- `POST /v1/chat/completions` with `stream: true` for SSE

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
