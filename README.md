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
surfaces use preview data until the gateway API is connected.

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

The local server binds to `127.0.0.1:8787` by default. Configure credentials
through environment variables; they are read server-side and are never logged.

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
OMNIHILBRAS_COMPATIBLE_API_KEY=...
```

Available routes:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/chat/completions` with `stream: true` for SSE

Use the `x-omnihilbras-provider` header to select a configured provider, for
example `x-omnihilbras-provider: anthropic`.
