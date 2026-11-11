# Web-cookie port: Perplexity Web and Grok Web

Status: in progress. Target release: `3.7.0`.

## Why

The current tree has six Web Cookie session providers. The old tree at
`/home/gin/work/Hilbras/OmniHilbras.old` has eight: the same six, plus two
single-cookie providers that were not carried over.

| Provider | Old implementation | Current |
| --- | --- | --- |
| Perplexity Web | `open-sse/executors/perplexity-web.js` | missing |
| Grok Web | `open-sse/executors/grok-web.js` | missing |
| ChatGPT Web | executor + `shared/webSession/chatgpt-web.js` | `Kernel/SDK/chatgpt-web` |
| Qwen Web | executable chat path | probe only |
| DeepSeek Web | executor + shared session | `Kernel/SDK/deepseek-web` |
| Token Harbor Web | executor + shared session | `Kernel/SDK/tokenharbor-web` |
| Gemini Web | executor + shared session | `Kernel/SDK/gemini-web` |
| Duck.ai | executor + shared session | `Kernel/SDK/duckduckgo-web` |

The old catalog documents both missing providers, and the current tree already
has their logos:

```text
public/providers/grok-web.png
public/providers/perplexity-web.png
```

## Scope

The six requested points:

1. Port **Perplexity Web**.
2. Port **Grok Web**.
3. Add both as Web Cookie cards and connect descriptors with whole-account
   session warnings.
4. Add model prefixes `pw/` and `gw/`.
5. Port the useful old tests as current SDK/gateway tests.
6. Resolve the streaming gap explicitly instead of leaving it ambiguous.

## Decisions

### Perplexity Web

- Provider id: `perplexity-web`.
- Credential: `__Secure-next-auth.session-token`, or a Cookie header containing it.
- Endpoint: `https://www.perplexity.ai/rest/sse/perplexity_ask`.
- Models: the seven ids from the old registry: `pplx-auto`, `pplx-sonar`,
  `pplx-gpt`, `pplx-gemini`, `pplx-sonnet`, `pplx-opus`, `pplx-nemotron`.
- Transport: SSE with `search`/thinking blocks and a bounded follow-up session
  cache, ported from `open-sse/executors/perplexity-web.js`.
- The adapter implements `chat` and `streamChat`; a real stream is forwarded as
  chunks rather than assembled into one.

### Grok Web

- Provider id: `grok-web`.
- Credential: `sso` cookie, with or without the `sso=` prefix.
- Endpoint: `https://grok.com/rest/app-chat/conversations/new`.
- Models: the twelve ids from the old registry, `grok-3` through `grok-4.2`.
- Transport: NDJSON, browser-fingerprint headers (`x-statsig-id`,
  `x-xai-request-id`, `traceparent`), and the old model-mode map.
- The adapter implements `chat` and `streamChat`.

### Streaming

The gateway reads `capabilities.streaming` before calling `streamChat`, so an
adapter with the flag false returns `NOT_SUPPORTED` even if it has a stream
method. That is how the current web-cookie adapters behave.

For this port:

- The two new adapters declare `streaming: true` only where the upstream really
  delivers incrementally. Perplexity and Grok do.
- The existing six stay non-streaming unless their upstream can be forwarded
  honestly. Qwen has no chat adapter to stream.
- The existing `streamChat` methods that yield a whole answer as one chunk are
  not presented as token streaming. Their capability flags stay false.
- `docs/SPEC-SDK.md` gets a table naming each web-cookie provider's streaming
  state, so a client can see the difference before sending `stream: true`.

This closes point 6 by making the rule explicit and tested, not by turning a
single-chunk answer into a fake token stream.

### Credential checks

Saving a credential is a write, so it must be proven before it is stored:

- `check` routes are side-effect free and store nothing.
- `connect` routes call the same check first, then save with
  `saveConnection`.
- A 401/403 is `AUTHENTICATION_FAILED`; 429 is `RATE_LIMITED`; 5xx is
  `PROVIDER_UNAVAILABLE`. A 400 on a deliberately minimal probe means the
  credential was accepted but the probe body was refused, not that the cookie is
  dead.
- No route claims `verified: 'inference'` when it only checked a cookie.

## Phases

### 1. SDK packages and unit tests

- [x] Create `Kernel/SDK/perplexity-web/` with vendored `lib/` files copied from
      `Kernel/SDK/tokenharbor-web/` and its own `adapter/index.ts`.
- [x] Port the old SSE parser, model map, citation/reasoning cleanup and
      follow-up session cache.
- [x] Create `Kernel/SDK/grok-web/` with the old NDJSON parser, model map and
      browser fingerprint.
- [x] Add `Kernel/SDK/tests/perplexity-web.test.js` and
      `Kernel/SDK/tests/grok-web.test.js`, driven by recorded fixture bytes, not
      live requests.
- [x] Add `Kernel/SDK/tests/web-cookie-streaming.test.js` covering the
      capability rule and the new adapters' chunk boundaries.

### 2. Gateway wiring

- [x] Import the new adapters in `Kernel/API/src/core/service.ts` and register
      them with `.onDemand(...)`.
- [x] Add `checkPerplexityWeb`, `connectPerplexityWeb`, `checkGrokWeb` and
      `connectGrokWeb` service methods.
- [x] Add `POST /v1/web-cookie/perplexity/check`, `/connect`,
      `/v1/web-cookie/grok/check` and `/connect` to
      `Kernel/API/src/routes/oauth.ts`.
- [x] Add the four routes to `docs/SPEC-SDK.md`; `tests/gateway-routes.test.js`
      must stay green.
- [x] Add `Kernel/API/test/web-cookie-grok-perplexity.test.js` with a mocked
      transport and a key-enforcement assertion.

### 3. Catalog, dialog and model ids

- [x] Add `perplexity-web` and `grok-web` to `src/data/providers.ts` under
      `group: 'web-cookie'`, with `riskSeverity: 'high'`, no invented metrics,
      their committed logos, endpoints and model lists.
- [x] Add both entries to `src/lib/webSessionProviders.ts` with copy/paste
      instructions, check and connect paths, and the cookie names.
- [x] Add `perplexity-web: 'pw'` and `grok-web: 'gw'` to
      `Kernel/API/src/core/provider-slugs.ts`; keep `grok` (`gk`) separate.
- [x] Update `tests/provider-cards.test.js`, `tests/provider-card-merge.test.js`
      and `tests/provider-options.test.js` counts and near-miss coverage.
      `dashboard-assets.test.js` should need no new asset.
- [x] Update `docs/architecture/9router-provider-catalog.md` with the two cards
      and their model tables.

### 4. Streaming audit and docs

- [x] Add a web-cookie streaming section to `docs/SPEC-SDK.md`: provider,
      upstream transport, capability flag and what `stream: true` produces.
- [x] Add/keep tests that assert `NOT_SUPPORTED` for a non-streaming adapter and
      real chunks for the two new ones.
- [x] Do not flip the existing six to `streaming: true` unless their chunk
      boundaries are real. If a later change does, update the tests that pin the
      current flags.

### 5. Verification and release

- [x] `pnpm verify` passes.
- [x] `pnpm version:check` reports `3.7.0`; update `package.json`,
      `Kernel/API/package.json`, `android/app/build.gradle`, README, SPEC
      status, `tasks/plan.md` and the release-notes draft.
- [ ] Build the Android debug APK and verify `versionName 3.7.0`.
- [ ] Commit, tag `v3.7.0`, push `main`, create the GitHub release, attach the
      APK, and let the desktop workflow attach Linux/Windows/macOS assets.
- [ ] Confirm `gh run view` success and list the release assets.

## Verification commands

```bash
pnpm --filter @omnihilbras/kernel-api build
node --test Kernel/SDK/tests/perplexity-web.test.js \
  Kernel/SDK/tests/grok-web.test.js \
  Kernel/SDK/tests/web-cookie-streaming.test.js
node --test Kernel/API/test/web-cookie-grok-perplexity.test.js
node --test tests/provider-cards.test.js tests/provider-options.test.js \
  tests/provider-card-merge.test.js tests/dashboard-assets.test.js \
  tests/gateway-routes.test.js
pnpm verify
```

## Explicit non-goals

- Qwen Web chat: the TMD gate is still a human puzzle. The probe stays.
- Live provider calls during CI. Credentials are user-owned; tests use recorded
  bytes and mocked transports. Manual checks with a real cookie are separate and
  are not claimed as passing in this plan.
- New logos: both files already exist and are committed.
