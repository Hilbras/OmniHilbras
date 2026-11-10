<p align="center">
  <img src="./brand/wordmark.svg" alt="OmniHilbras" width="360" />
</p>

<p align="center">
  <strong>One local endpoint for every model provider.</strong><br />
  A local-first AI gateway, dashboard and desktop app with routing, failover, token accounting and measured token saving.
</p>

<p align="center">
  <a href="https://github.com/Hilbras/OmniHilbras/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/Hilbras/OmniHilbras" /></a>
  <a href="https://github.com/Hilbras/OmniHilbras/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/Hilbras/OmniHilbras/actions/workflows/verify.yml/badge.svg" /></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6" />
</p>

<p align="center">
  <a href="https://omnihilbras.hilbras.com/download">Download</a> ·
  <a href="https://omnihilbras.hilbras.com/docs">Documentation</a> ·
  <a href="https://omnihilbras.hilbras.com/changelog">Changelog</a> ·
  <a href="./docs/SPEC-SDK.md">Gateway specification</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

**Current version: 3.2.0**

OmniHilbras sits between your application and the model providers you already use. It gives every client one
OpenAI-compatible endpoint, keeps credentials on your machine, and decides which saved connection should serve
each request. The same repository ships the gateway, the React dashboard, the marketing site and the Electron
desktop app.

> **Publishing status:** the npm package is legacy. Kernel/API is private while the Kernel restructure is in
> progress, so the supported install paths are the desktop app and a build from source. See
> [`AGENTS.md`](./AGENTS.md) for the release rules that apply today.

## Why OmniHilbras

- **One API, many providers.** Point any OpenAI-compatible client at loopback. Provider-specific wire formats
  stay inside their adapters; the gateway core stays provider-neutral.
- **Local by default.** The gateway binds to `127.0.0.1`, credentials live in an encrypted local vault, and
  provider keys never enter browser storage.
- **Failover instead of silent failure.** Connections carry a priority and a health state. A request skips an
  unhealthy, rate-limited or credential-less connection and records which one failed.
- **Measured, not invented.** Usage records carry tokens, cache reads and writes, request IDs and the ordered
  attempts. A value that was not measured is shown as unmeasured, never as zero.
- **Token saving you can audit.** Compression, history trimming and cache anchoring are separate, reversible
  savers with per-request telemetry in `GET /v1/token-saver/stats`.
- **Desktop and web.** The desktop app owns the gateway lifecycle, logs and updates; the browser dashboard
  remains available for development.

## Install

### Desktop app

Download the latest installer from [the download page](https://omnihilbras.hilbras.com/download):

| Platform | Package |
| --- | --- |
| Windows 10/11 x64 | `OmniHilbras-Setup.exe` |
| Linux x64 | `OmniHilbras-linux-amd64.AppImage` (self-updating) or `OmniHilbras-linux-amd64.deb` |
| macOS | `OmniHilbras-macos.dmg` (built on macOS CI) |

Stable direct links:

```text
https://github.com/Hilbras/OmniHilbras/releases/latest/download/OmniHilbras-Setup.exe
https://github.com/Hilbras/OmniHilbras/releases/latest/download/OmniHilbras-linux-amd64.AppImage
https://github.com/Hilbras/OmniHilbras/releases/latest/download/OmniHilbras-linux-amd64.deb
https://github.com/Hilbras/OmniHilbras/releases/latest/download/OmniHilbras-macos.dmg
```

The Windows and macOS builds are not code-signed yet. SmartScreen or Gatekeeper may ask you to confirm the
first launch. The AppImage updates itself without administrator rights. The `.deb` can be downloaded from the
app and opened in the system installer, which still asks for administrator permission; install it with:

```bash
sudo apt install ./OmniHilbras-linux-amd64.deb
```

### From source

Requirements: Node.js 24+, pnpm 12.5.1.

```bash
pnpm install
pnpm dev            # marketing site + dashboard on :5173
pnpm dev:gateway    # local gateway on 127.0.0.1:8787
```

The desktop app has its own commands:

```bash
pnpm app:dev        # build the gateway and dashboard, then open Electron
pnpm app:check      # build and drive the real binary through its smoke test
pnpm app:pack       # build installers for the current platform
```

## Architecture

```text
┌──────────────────────────────┐
│  Desktop app (Electron)      │  window controls, tray, gateway lifecycle,
│  desktop/                    │  logs, updates, encrypted backup
└──────────────┬───────────────┘
               │ app:// + narrow preload bridge
┌──────────────▼───────────────┐
│  Dashboard + marketing site  │  React Router under /dashboard
│  src/                        │  static pages under /home and /site/
└──────────────┬───────────────┘
               │ HTTP / SSE, loopback
┌──────────────▼───────────────┐
│  Kernel/API                  │  routing, health, retries, usage, keys,
│  gateway service             │  token-saver orchestration, OAuth routes
└───────┬──────────────┬───────┘
        │              │
┌───────▼───────┐ ┌────▼──────────────────────────┐
│ Kernel/       │ │ Kernel/SDK/<provider>/        │
│ TokenSaver    │ │ one adapter package per provider│
└───────────────┘ └───────────────────────────────┘
```

The important boundary is **the gateway core does not speak provider wire formats**. A provider is an adapter
and a registration. The shared machinery each adapter needs is vendored into that package's `lib/`; there is no
shared SDK core to drift away from them.

### Repository map

| Path | Responsibility |
| --- | --- |
| `Kernel/API/` | Gateway, routes, routing, health, usage, vault, token-saver integration |
| `Kernel/SDK/<provider>/` | Provider adapter and vendored runtime types |
| `Kernel/TokenSaver/` | Standalone, reversible context compressor and saver telemetry |
| `src/` | React dashboard and marketing pages |
| `site/` | Static entry files for Home, Download, Docs and legal pages |
| `desktop/` | Electron main process, preload bridge and supervisor |
| `docs/` | Specification, architecture notes, reports and tools |
| `tests/` | Repository-wide guards, brand, security and documentation checks |

## Gateway

The gateway listens on `127.0.0.1:8787` by default. It refuses a non-loopback host unless deployment
configuration explicitly changes the threat model.

### Core routes

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | Chat, streaming and tool calls through the selected provider |
| `POST /v1/responses` | OpenAI Responses API shape |
| `GET /v1/models` | Saved models of enabled, credentialed connections |
| `POST /v1/messages/count_tokens` | Explicit bytes/4 estimate, marked as estimated |
| `POST /v1/embeddings` | Embeddings where the provider supports them |
| `GET /health` | Gateway and provider health, including the reason for each unavailable provider |
| `GET /v1/usage` | Recorded usage, paged and filterable |
| `GET /v1/token-saver/stats` | Per-saver savings, skips and cache figures |
| `GET /v1/settings` | The configuration this process actually loaded |

Management routes use the admin key when enforcement is on. The full route contract, including OAuth callbacks,
backup import/export and every rejection shape, is in [`docs/SPEC-SDK.md`](./docs/SPEC-SDK.md).

### Quick request

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $OMNIHILBRAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

`model: "auto"` lets the gateway resolve a saved connection. A concrete model id is routed to the connection
that lists it, then to an explicit `x-omnihilbras-provider` header or body field if one is present. The routing
order is deterministic: priority, health, credential, rate limit, then failover.

## Providers

Provider integrations live under `Kernel/SDK/`. The gateway supports API-key providers, OAuth providers,
web-session providers, local runtimes such as Ollama, and generic OpenAI-compatible endpoints.

- **API key:** the credential is stored in the local encrypted vault.
- **OAuth:** the gateway owns the sign-in session and saves the resulting credential. The desktop app opens the
  provider page in your default browser.
- **Web session:** a pasted cookie is verified against the provider before it is stored.
- **Local:** no credential is required; the connection is saved with `credential: "none"`, not an invented key.
- **Custom endpoint:** any OpenAI-compatible base URL with optional model and chat paths.

Provider cards are catalog metadata. A card shows `—` metrics and `No connections` until a real connection
exists; it never invents a measurement. See the provider notes in the [gateway specification](./docs/SPEC-SDK.md)
for auth-specific behavior and standing warnings.

## Token saver

The saver is a separate package, not a mode hidden in the adapter:

- **RTK filters** recognize git, build, grep, find, tree, ls, search and log output shapes.
- **Generic compression** preserves valid JSON, error rows and retrievable originals.
- **History trimming** stubs whole old turns above a threshold while keeping the system prompt, the first user
  ask, the recent window and error-bearing tool results.
- **Output and thinking caps** clamp requests before routing; Anthropic re-clamps its own thinking budget.
- **`count_tokens`** is an estimate with an explicit `estimated` field; no provider tokenizer is bundled.
- **Cache anchoring** re-anchors Anthropic cache breakpoints on the final body, after the savers run.
- **Optional external savers** — Headroom and PXPIPE — are fail-open, time out, and report `ran` or `skipped`
  with a reason. PXPIPE only runs for adapters that advertise Anthropic image context.

Every lossy rewrite that stores an original is reversible through `GET /v1/token-saver/:id`. Cache reads and
writes are accounted for separately from prompt tokens, and cached input is priced as cached input.

Configuration:

```bash
OMNIHILBRAS_TOKEN_SAVER=1
# OMNIHILBRAS_TOKEN_SAVER_RATIO=0.5
# OMNIHILBRAS_TOKEN_SAVER_PROTECT_RECENT=4
# OMNIHILBRAS_TOKEN_SAVER_USERS=1
# OMNIHILBRAS_TOKEN_SAVER_CODE=1
# OMNIHILBRAS_TOKEN_SAVER_REVERSIBLE=true
# OMNIHILBRAS_TOKEN_SAVER_CCR_LIMIT=500

OMNIHILBRAS_HISTORY_TRIM_TOKENS=120000
OMNIHILBRAS_HISTORY_TRIM_KEEP_RECENT=8
OMNIHILBRAS_MAX_OUTPUT_TOKENS=8192
OMNIHILBRAS_THINKING_BUDGET=4096
OMNIHILBRAS_CACHE_ANCHOR=1
```

External savers are opt-in by URL. A request never depends on them:

```bash
OMNIHILBRAS_HEADROOM_URL=http://127.0.0.1:8788
OMNIHILBRAS_PXPIPE_URL=http://127.0.0.1:8789
```

## Dashboard

The dashboard is one React Router app mounted at `/dashboard`. Client-side navigation never reloads the
document.

| Route | Page |
| --- | --- |
| `/dashboard/providers` | Provider catalog and connections |
| `/dashboard/providers/:providerId` | Provider overview |
| `/dashboard/providers/:providerId/usage` | Usage scoped to that provider |
| `/dashboard/routing` | Routing order and connection state |
| `/dashboard/keys` | Gateway API keys |
| `/dashboard/usage` | Requests, tokens, cache and cost |
| `/dashboard/logs` | Live request log |
| `/dashboard/settings` | Loaded configuration and desktop settings |

There is no Overview page: the earlier one had no data source and was removed rather than kept. `/dashboard`
redirects to providers.

A static host must send every `/dashboard/*` request to `dashboard.html`. `public/_redirects` covers Netlify and
Cloudflare Pages; the equivalent nginx rule is:

```nginx
location /dashboard { try_files $uri /dashboard.html; }
```

## Desktop app

The desktop shell owns the local gateway so the app can start and stop it without a terminal.

- **Frameless on Windows/Linux**, with the dashboard header as the title bar and custom window controls.
  macOS keeps its traffic lights.
- **Gateway lifecycle** — start, stop, restart, port changes and a bounded restart policy. A crash is a restart,
  not a dead app; five consecutive crashes stop trying.
- **Logs** stream into the dashboard over the preload bridge.
- **Release-feed updates** — the app checks the GitHub release feed, downloads an installer, and can install
  and restart. Windows NSIS, signed macOS and the Linux AppImage replace themselves; a `.deb` downloads and
  opens the system installer, which asks for administrator permission.
- **Encrypted backup** import and export through the About/Settings surfaces.

The renderer never holds the dashboard token and never calls `127.0.0.1` directly. Requests, chat streams and
logs cross a narrow preload bridge. The packaged dashboard is served from `app://omnihilbras` out of `dist/`
with a strict CSP, all permission requests denied, navigation away from the app blocked, and DevTools disabled.

## Configuration

The gateway is configured by environment variables. The full list is in [`docs/SPEC-SDK.md`](./docs/SPEC-SDK.md);
the ones most people change:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIHILBRAS_HOST` | `127.0.0.1` | Loopback host; non-loopback values are refused in local mode |
| `OMNIHILBRAS_PORT` | `8787` | Gateway port |
| `OMNIHILBRAS_DATA_DIR` | XDG config | Connections, vault, usage and settings |
| `OMNIHILBRAS_REQUIRE_API_KEY` | — | Require an admin/LLM key for management and inference |
| `OMNIHILBRAS_TOKEN_SAVER` | off | Enable local context compression |
| `OMNIHILBRAS_MAX_OUTPUT_TOKENS` | none | Hard output cap |
| `OMNIHILBRAS_THINKING_BUDGET` | none | Thinking-budget cap where supported |
| `OMNIHILBRAS_HISTORY_TRIM_TOKENS` | none | Trim whole old turns above this estimate |
| `OMNIHILBRAS_CACHE_ANCHOR` | off | Re-anchor provider cache breakpoints |
| `OMNIHILBRAS_HEADROOM_URL` | none | Optional external compressor |
| `OMNIHILBRAS_PXPIPE_URL` | none | Optional Anthropic image-context hook |

Secrets are read from the environment or the encrypted vault. A credential must never be committed, pasted into
an issue, or written to browser storage.

## Security and privacy

- **Loopback by default.** `OMNIHILBRAS_HOST` is validated as a loopback address more than once, so a typo or a
  second code path cannot widen the listener silently.
- **Encrypted vault.** Provider credentials are written atomically with owner-only permissions; the vault is
  encrypted at rest. Backups use AES-256-GCM with a scrypt-derived key and are unreadable without the passphrase.
- **No credential in browser storage.** Every `localStorage`/`sessionStorage` key is on a two-entry allowlist;
  `sessionStorage`, `document.cookie` writes, IndexedDB and the Cache API are asserted at zero.
- **No secret-shaped string in the tree.** `tests/no-secrets.test.js` scans tracked files for credential shapes
  on every push.
- **Fail closed on bad configuration.** A malformed cap, URL or master key is a startup error, not a silent
  fallback.
- **Optional services fail open.** Headroom and PXPIPE time out and leave the request untouched; a skipped saver
  is reported as skipped, not as a saving.

The full threat model and known limits are in [`SECURITY.md`](./SECURITY.md).

## Development

```bash
pnpm install
pnpm dev              # marketing + dashboard on :5173
pnpm dev:gateway      # gateway on :8787
pnpm typecheck
pnpm test             # SDK, gateway, token-saver and repository guards
pnpm build
pnpm analyze          # per-page bundle cost, attributed per package
pnpm verify           # version, brand, typecheck, test, SPEC guard, build, bundle budget
pnpm release:audit    # every tag: pushed, released on GitHub, published to npm
```

`pnpm verify` is the release gate. It is the same command CI runs, in the order that fails fastest.

### Tests are guards, not decoration

The repository has a large test suite, but the important part is what the guards assert: provider cards do not
invent measurements, credentials never reach browser storage, every served gateway route has a SPEC line, every
tag is on `main`, every rendered provider mark is committed, and an update feed missing `latest.yml` fails instead
of looking healthy.

A guard is not considered real until it has been made to fail on the thing it forbids. Several tests in this
repository record the mutation that first proved them blind; keep that habit when adding one.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/SPEC-SDK.md`](./docs/SPEC-SDK.md) | Gateway routes, provider contract, rejection shapes and success criteria |
| [`docs/architecture/README.md`](./docs/architecture/README.md) | Measured architecture, layer boundaries and provider-specific surface |
| [`docs/architecture/embeddings-plan.md`](./docs/architecture/embeddings-plan.md) | Embeddings design and dispatch rules |
| [`docs/reports/`](./docs/reports/) | Performance, reliability, release readiness and provider test reports |
| [`docs/tools.md`](./docs/tools.md) | How to run one-off probes without committing them |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | The rules a change must satisfy |
| [`SECURITY.md`](./SECURITY.md) | Reporting, threat model and known limits |
| [`AGENTS.md`](./AGENTS.md) | Working agreement, release checklist and repository boundaries |

## License

MIT. See [`LICENSE`](./LICENSE).
