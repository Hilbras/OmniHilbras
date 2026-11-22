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
  <a href="https://www.npmjs.com/package/@hilbras/omnihilbras"><img alt="npm" src="https://img.shields.io/npm/v/@hilbras/omnihilbras?label=cli" /></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6" />
  <img alt="Node 24+" src="https://img.shields.io/badge/Node-24%2B-339933" />
</p>

<p align="center">
  <a href="https://omnihilbras.hilbras.com/download">Download</a> ·
  <a href="https://omnihilbras.hilbras.com/docs">Documentation</a> ·
  <a href="https://omnihilbras.hilbras.com/changelog">Changelog</a> ·
  <a href="./docs/SPEC-SDK.md">Gateway specification</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

**Current version: 3.93.0**

OmniHilbras sits between your application and the model providers you already use. It gives every client one
OpenAI-compatible endpoint, keeps credentials on your machine, and decides which saved connection serves each
request. One repository ships the gateway, the React dashboard, the marketing site, the Electron desktop app,
an Android companion shell and the `omnihilbras` command line.

---

## Quick start

```bash
# 1. Run it
pnpm install && omnihilbras          # gateway on 127.0.0.1:20138, dashboard on :20137

# 2. Add a provider (browser) — or from the CLI:
omnihilbras providers                # what is already saved
omnihilbras test zcode               # prove an account can actually serve

# 3. Point any OpenAI-compatible client at it
curl http://127.0.0.1:20138/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

`model: "auto"` lets the gateway pick a saved connection. A concrete id (`zc/glm-5.3-flash`) routes to the
account that lists it. Either way the decision is deterministic and recorded — see
[How a request is routed](#how-a-request-is-routed).

## Contents

| | |
| --- | --- |
| **Using it** | [Features](#features) · [Install](#install) · [Providers](#providers) · [Accounts](#accounts) · [Virtual models](#virtual-models) · [Token saver](#token-saver) · [Dashboard](#dashboard) · [Desktop app](#desktop-app) · [Android companion](#android-companion) · [CLI](#cli) |
| **Under the hood** | [Architecture](#architecture) · [How a request is routed](#how-a-request-is-routed) · [Gateway](#gateway) · [Configuration](#configuration) |
| **Project** | [Security and privacy](#security-and-privacy) · [Current state](#current-state) · [Development](#development) · [Documentation](#documentation) · [License](#license) |

## Features

| | |
| --- | --- |
| **One API, many providers** | Any OpenAI-compatible client points at loopback. Provider wire formats stay inside their adapters; the gateway core is provider-neutral. |
| **Local by default** | Binds `127.0.0.1`, refuses a non-loopback host unless you change the threat model deliberately. Credentials live in an encrypted vault, never in browser storage. |
| **Accounts, not just providers** | Several accounts per provider, each with its own credential, models, priority, limits and usage attribution — and a routing walk that tries them in order. |
| **Failover that names the cause** | A refusal about an *allowance* moves to the next account; a refusal about *you* (restriction, dead credential, malformed request) stops and says why. |
| **Measured, not invented** | Usage records carry tokens, cache reads and writes, request ids and the ordered attempts. A value nobody measured is shown as unmeasured, never as zero. |
| **Token saving you can audit** | Compression, history trimming, output caps and cache anchoring are separate, reversible savers with per-request telemetry. |
| **Virtual models** | One public id (`oh/chat`) that routes across several accounts and providers, with a strategy you choose. |
| **Everything is a surface** | Browser dashboard, desktop app, CLI verbs with `--json`. The CLI and the dashboard call the same routes, so they cannot hold two opinions. |

## Install

### Desktop app

Download from [the download page](https://omnihilbras.hilbras.com/download):

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

The Windows and macOS builds are **not code-signed yet**, so SmartScreen or Gatekeeper asks you to confirm
the first launch, and an update asks before installing because the app cannot prove where it came from. The
AppImage updates itself without administrator rights. The `.deb` downloads and opens the system installer,
which asks for administrator permission:

```bash
sudo apt install ./OmniHilbras-linux-amd64.deb
```

### The `omnihilbras` command

```bash
npm i -g @hilbras/omnihilbras
```

It installs the **client**: `status`, `providers`, `models`, `test`, `keys`, `routing`, `logs`, `setup`,
`doctor`. Since `3.73.0` the package also contains the server: `npm pack` stages a bundled gateway,
the built dashboard and its locales, so `omnihilbras` with no verb starts both halves and opens the
dashboard. The desktop app remains another way to run it.

> Versions before `3.0.0` under this name are a **different program** (the previous project, whose
> `omnihilbras` started a server). They are deprecated with that warning. See
> [`NPM-PUBLISH.md`](./NPM-PUBLISH.md) for what is published and what is not.

### From source

| Requirement | Version |
| --- | --- |
| Node.js | 24 or newer (`.nvmrc`) |
| pnpm | 12.5.1 (`packageManager` in `package.json`) |

```bash
pnpm install
pnpm dev            # marketing site + dashboard on :20137
pnpm dev:gateway    # local gateway on 127.0.0.1:20138
```

Desktop app commands:

```bash
pnpm app:dev        # build the gateway and dashboard, then open Electron
pnpm app:check      # build and drive the real binary through its smoke test
pnpm app:pack       # build installers for the current platform
```

Installing, the first-run check and removing every version from a machine: [`docs/INSTALL.md`](./docs/INSTALL.md).

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

The important boundary: **the gateway core does not speak provider wire formats.** A provider is an adapter
plus a registration, and the shared machinery each adapter needs is vendored into that package's `lib/`, so
there is no shared SDK core to drift away from them.

### Repository map

| Path | Responsibility |
| --- | --- |
| `Kernel/API/` | Gateway: routes, routing, health, usage, vault, token-saver integration |
| `Kernel/SDK/<provider>/` | Provider adapter and vendored runtime types, one package per provider |
| `Kernel/TokenSaver/` | Standalone, reversible context compressor and saver telemetry |
| `src/` | React dashboard and marketing pages |
| `site/` | Static entry files for Home, Download, Docs and legal pages |
| `desktop/` | Electron main process, preload bridge and supervisor |
| `cli/` | The published `@hilbras/omnihilbras` client, and `bin/omnihilbras.js`'s verbs |
| `android/` | Capacitor companion shell for the dashboard |
| `docs/` | Specification, architecture notes, reports and tools |
| `tests/` | Repository-wide guards: brand, security, documentation, release trail |

## How a request is routed

The order is fixed, and each step can be read back from `GET /v1/routing`.

1. **Virtual models first.** An enabled `oh/…` id expands into one route candidate per target; a disabled one
   has no candidates and does *not* fall back to a provider model with the same suffix.
2. **Candidates are filtered, not guessed.** A connection must be enabled, have a credential, not be
   serving-time ejected, and not be cooling down for that model. Whatever is skipped is listed with a reason
   (`unhealthy`, `model-cooling-down`, `no-models`, …).
3. **Ordering.** A named account (`x-omnihilbras-connection`) goes first **regardless of priority**; otherwise
   connections sort by priority then name, with the provider's strategy (`priority`, `round-robin`,
   `fastest`) applied on top.
4. **The walk.** Accounts are tried one at a time. What a failure *means* decides the next step:

   | The failure says | The response |
   | --- | --- |
   | The allowance is gone (`429`, `402`, `403`, `404`, `5xx`, or wording like `quota exceeded`, `insufficient_quota`, `exceed quota limit`) | **Next account** — a sibling has its own allowance |
   | The account is *restricted* (`request illegal`, `unusual activity`, `账号存在异常行为`) | **Stop.** Asking the next account through the same fingerprint is how one restricted account becomes several |
   | The credential is dead (`401`) | **Next account first** — a sibling has its own key and can answer — then stop and name that account when none is left. The dead credential is recorded against the account that owns it, so it stays visible |
   | The request is wrong (`INVALID_REQUEST`, `NOT_SUPPORTED`) | **Stop** — every account refuses it identically |
   | The account is busy (our own concurrency cap) | **Stop** with "at its concurrency limit" — nothing was sent |
   | The provider is unwell (`5xx`) | **Next account** — a sibling may be on a healthier host; a timeout spends that connection's retry budget first |

5. **Cool-downs are per account *and* model, and they persist.** A refusal stands down that account for that
   model — it is still used for every other model — for a wait that grows (`60 s × 2^(level-1)`, capped at 30
   minutes) and resets on a success. A provider that states its own reset time is believed instead. The state
   lives in the vault, so a restart does not re-hammer the account that just refused.
6. **The answer carries its own audit.** The attempt ledger names each account, whether it answered, and the
   error code if it did not; usage records keep the same information afterwards.

## Gateway

Listen address `127.0.0.1:20138` by default. A non-loopback host is refused unless deployment configuration
explicitly changes the threat model.

### Core routes

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | Chat, streaming and tool calls through the selected provider |
| `POST /v1/responses` | OpenAI Responses API shape |
| `GET /v1/models` | Saved models of enabled, credentialed connections, plus enabled virtual models |
| `POST /v1/messages/count_tokens` | Explicit bytes/4 estimate, marked as estimated |
| `POST /v1/embeddings` | Embeddings where the provider supports them |
| `GET /health` | Gateway and provider health, with the reason for each unavailable provider |
| `GET /v1/routing` | Live routing state: failures, ejection, rate-limit waits, measured latency |
| `GET /v1/connections` | Saved accounts and their credentials' kind |
| `POST /v1/connections/:id/probe` | Validate one account with its own stored credential |
| `GET /v1/keys` | Gateway API keys (metadata only; a secret is returned once, at creation) |
| `GET /v1/usage` | Recorded usage, paged and filterable |
| `GET /v1/token-saver/stats` | Per-saver savings, skips and cache figures |
| `GET /v1/logs/stream` | Each finished request as a server-sent event — no prompt content, no credential |
| `GET /v1/settings` | The configuration this process actually loaded |

Management routes use the admin key when enforcement is on. The full contract — OAuth callbacks, backup
import/export, error shapes, and every rejection — is [`docs/SPEC-SDK.md`](./docs/SPEC-SDK.md).

### Quick request

```bash
curl http://127.0.0.1:20138/v1/chat/completions \
  -H "Authorization: Bearer $OMNIHILBRAS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

## Providers

Integrations live under `Kernel/SDK/`, one adapter package per provider. Five kinds of auth are supported:

- **API key** — the credential is stored in the local encrypted vault.
- **OAuth** — the gateway owns the sign-in session and saves the resulting credential; the desktop app opens
  the provider page in your default browser.
- **Web session** — a pasted cookie or token is verified against the provider before it is stored. Cards exist
  for ChatGPT Web, Qwen Web, DeepSeek Web (and a V2 group), Token Harbor Web, Gemini Web, Duck.ai, Grok Web
  and Perplexity Web. Grok and Perplexity forward real streams; DeepSeek and Duck.ai return one completed
  chunk; the rest declare `streaming: false` and say so in the spec. DeepSeek Web and Duck.ai support
  prompt-level DSML tool rounds; DeepSeek also supports images and bounded session reuse.
- **Local runtime** — no credential at all. The connection is saved with `credential: "none"` rather than an
  invented empty key, which is why the save path asks you to say so.
- **Custom endpoint** — any OpenAI-compatible base URL, with optional model and chat paths.

Cline and ClinePass are two cards with their own connection records, model lists and usage attribution. Both
accept a Cline API key; sign-in uses Cline's WorkOS session, and a ClinePass OAuth account links to the Cline
account explicitly rather than through a global alias. 100milionseek is a free OpenAI-compatible provider
(`https://100milionseek.top/v1`) with one `deepseek-v4.1-flash-free` model and a daily token allowance.

Provider cards in `src/data/providers.ts` are **catalog metadata**: they show `—` metrics and `No connections`
until a real connection exists, and never invent a measurement. Provider-specific behaviour and standing
warnings are in the [gateway specification](./docs/SPEC-SDK.md).

## Accounts

A saved connection **is** an account. One provider may have several, each with its own credential, model list,
priority, limits and usage attribution — the multi-account model is the core of the routing above.

- **Explicit selection.** `x-omnihilbras-connection: <id>` or the `connection` body field puts that account
  first. It is a **preference, not a fence**: when it refuses for an allowance reason, its siblings are tried.
  An unknown id is `INVALID_REQUEST`; a *disabled* named account is refused rather than quietly replaced.
- **Independent limits.** `resilience.requestsPerMinute` and `resilience.maxConcurrentRequests` are keyed by
  account. A concurrency refusal is not a provider failure and does not cool the model for another account.
- **Authentication isolation.** `AUTHENTICATION_FAILED` is terminal for that account; it is not retried on the
  next one, because a dead credential is a fact about one account.
- **Network isolation is not claimed until enforced.** `proxyPool` is stored, but this build has no proxy
  transport: a connection naming a non-`none` pool is refused with `CONFIGURATION_ERROR` rather than sent
  direct. That matters most for providers that flag several accounts on one address — a code-level answer
  cannot make one machine look like several.

## Virtual models

A virtual model is one public id that routes to several saved accounts. Every virtual id starts with `oh/` —
the prefix is required, and keeps it distinct from a provider's own ids.

```text
oh/chat
  → openai     / gpt-4o
  → openrouter / openai/gpt-4o
  → ollama     / llama3.3
```

Manage them at `/dashboard/models`: each card shows the public id, name, enabled state, strategy, targets and
provider accounts. Disabling the card stops the alias without deleting its targets.

| Strategy | Behaviour |
| --- | --- |
| `priority` | Lower target priority first — usually a primary plus fallbacks |
| `round-robin` | Rotate the enabled targets in order |
| `fastest` | Prefer the account with a measured faster round trip; unmeasured targets last |

Each target becomes an ordinary route candidate with an upstream model override, so health, credentials, rate
limits, concurrency and the failure rules above apply unchanged. `GET /v1/models` lists enabled virtual models
with `virtual: true`; the management routes are `GET/POST /v1/virtual-models` and
`PUT/DELETE /v1/virtual-models/:id`.

## Token saver

A separate package, not a mode hidden in an adapter:

- **RTK filters** recognise git, build, grep, find, tree, ls, search and log output shapes.
- **Generic compression** preserves valid JSON, error rows and retrievable originals.
- **History trimming** stubs whole old turns above a threshold, keeping the system prompt, the first user ask,
  the recent window and error-bearing tool results.
- **Output and thinking caps** clamp requests before routing; Anthropic re-clamps its own thinking budget.
- **`count_tokens`** is an estimate with an explicit `estimated` field; no provider tokenizer is bundled.
- **Cache anchoring** re-anchors Anthropic cache breakpoints on the final body, after the savers run.
- **Optional external savers** — Headroom and PXPIPE — fail open, time out, and report `ran` or `skipped` with
  a reason. PXPIPE runs only for adapters that advertise Anthropic image context.

Every lossy rewrite that stores an original is reversible through `GET /v1/token-saver/:id`. Cache reads and
writes are accounted separately from prompt tokens, and cached input is priced as cached input.

```bash
OMNIHILBRAS_TOKEN_SAVER=1
# OMNIHILBRAS_TOKEN_SAVER_RATIO=0.5
# OMNIHILBRAS_TOKEN_SAVER_PROTECT_RECENT=4
# OMNIHILBRAS_TOKEN_SAVER_REVERSIBLE=true
OMNIHILBRAS_HISTORY_TRIM_TOKENS=120000
OMNIHILBRAS_HISTORY_TRIM_KEEP_RECENT=8
OMNIHILBRAS_MAX_OUTPUT_TOKENS=8192
OMNIHILBRAS_THINKING_BUDGET=4096
OMNIHILBRAS_CACHE_ANCHOR=1
OMNIHILBRAS_HEADROOM_URL=http://127.0.0.1:8788     # optional, opt-in by URL
OMNIHILBRAS_PXPIPE_URL=http://127.0.0.1:8789       # optional, opt-in by URL
```

## Dashboard

One React Router app mounted at `/dashboard`; client-side navigation never reloads the document.

| Route | Page |
| --- | --- |
| `/dashboard` | Gateway lifecycle, live host CPU/memory, server output and the request feed |
| `/dashboard/providers` | Provider catalog and connections |
| `/dashboard/providers/:providerId` | One provider: its accounts, models and check buttons |
| `/dashboard/providers/:providerId/usage` | Usage scoped to that provider |
| `/dashboard/models` | Virtual `oh/` models and their multi-account targets |
| `/dashboard/routing` | Routing order and connection state |
| `/dashboard/keys` | Gateway API keys |
| `/dashboard/usage` | Requests, tokens, cache and cost |
| `/dashboard/logs` | Live request log |
| `/dashboard/settings` | Loaded configuration and desktop settings |
| `/dashboard/token-saver` | Measured savings from context compression |
| `/dashboard/about` | Build provenance and the limits of this installation |

There is no Overview page: the earlier one had no data source and was removed rather than kept. `/dashboard`
is the Servers page; unknown paths under it redirect to providers.

A static host must send every `/dashboard/*` request to `dashboard.html`. `public/_redirects` covers Netlify
and Cloudflare Pages; the nginx equivalent is:

```nginx
location /dashboard { try_files $uri /dashboard.html; }
```

## Desktop app

The desktop shell owns the local gateway so the app can start and stop it without a terminal.

- **Its own port pair** — the packaged app runs its gateway on `127.0.0.1:20198` and trusts the web dashboard
  origin on `20197`, so it never competes with the development pair (`pnpm dev` on `20137`, `pnpm dev:gateway`
  on `20138`) or the original desktop pair (`20127`/`20128`). An install that saved one of the older gateway
  defaults (`8787`, `20137`, `20138`, `20128`) is migrated to `20198` on launch. If something else already holds
  `20198`, the supervisor takes a free port and the Servers page says which one — it refuses to kill a process
  it did not start. Both ports are overridable without rebuilding: set `OMNIHILBRAS_PORT` and
  `OMNIHILBRAS_WEB_PORT` before launch, or change them in the app's settings (a web-port change restarts the
  gateway so its trusted-origin list is refreshed).
- **Frameless on Windows/Linux**, with the dashboard header as the title bar and custom window controls.
  macOS keeps its traffic lights.
- **Gateway lifecycle** — start, stop, restart, port changes, and a bounded restart policy: a crash is a
  restart, not a dead app, and five consecutive crashes stop trying.
- **Logs** stream into the dashboard over the preload bridge.
- **Release-feed updates** — the app checks the GitHub release feed on launch and every six hours, downloads
  an installer, and can install and restart when that platform's feed supports it. Windows NSIS and the Linux
  AppImage replace themselves; a `.deb` downloads and opens the system installer; macOS needs a zip in the
  feed, so a dmg-only release offers the release page instead of a button that could only fail. An update that
  cannot be proved asks first, because there is no signing key yet. Both decisions are now explicit: when a
  newer release is found the app asks **Download now? / Not now**, and when the download finishes it asks
  **Install and restart? / Not now**. Accepting starts the action; declining leaves the badge in place so the
  same buttons can be used later, and does not skip the version. The unsigned warning is part of the install
  question rather than a second native prompt, and the main process still refuses a silent unsigned install.
- **The sidebar says when an update exists**, directly under the gateway badge: the new version, Download or
  Install and restart depending on what this build can do, and a **skip this version** remembered for that
  release only. The desktop reads the state its own main process keeps (it checks on launch and on a timer);
  a browser, which has no updater, asks GitHub for the newest release and offers the release page and the
  install command instead of a button that would do nothing. A check that fails says it failed — it never
  renders "up to date".
- **Every provider id owns its config and package.** `Kernel/Tools` keeps one registry row per catalog id, each id has
  its own SDK package and gateway registration, and an OAuth route exists only where a real sign-in flow does.
- **Tools follow one contract.** `Kernel/Tools` decides, per provider, whether `tools` are served and which
  `tool_choice` values can be honoured; a forced call to a provider that cannot force is a stated `501 NOT_SUPPORTED`
  rather than a request that quietly ignores it, returned `tool_calls` are validated and bounded-repaired, and a web
  session that cannot use the tools you sent says so — `tools: false` in `/v1/models` and `gateway.tools` in the answer.
  A separate, opt-in read-only layer (`OMNIHILBRAS_LOCAL_TOOLS=1` with `OMNIHILBRAS_LOCAL_TOOL_ROOTS`) lets any provider
  read files inside approved directories through the gateway; there is no shell, write or network tool.
- **Encrypted backup** import and export through the About/Settings surfaces. The file carries every store the
  gateway keeps — connections with their credentials (API keys, OAuth sign-ins, keyless providers), provider
  strategies and model aliases, the gateway's API keys, usage history, virtual models, skills, workspaces,
  tunnels, proxy pools, provider nodes, the MITM policy, and the session files of the ChatGPT Web and Gemini Web
  browser profiles. The master key and the dashboard token are deliberately excluded: credentials travel
  decrypted inside the AES-256-GCM envelope and are re-wrapped under the destination's own master key, so no
  backup carries the key that opens the machine it came from. Import replaces every section the file carries,
  leaves a store the file does not mention untouched, validates the whole payload before writing anything, and
  reports the sections it applied. Files from older releases, whose payload carried connections, strategies and
  API keys only, still import.

The renderer never holds the dashboard token and never calls `127.0.0.1` directly: requests, chat streams and
logs cross a narrow preload bridge. The packaged dashboard is served from `app://omnihilbras` out of `dist/`
with a strict CSP, all permission requests denied, navigation away from the app blocked, and DevTools disabled.

## Android companion

A debug Android shell lives under `android/`. It is a Capacitor WebView for the existing dashboard, **not** a
gateway on the phone. On first launch it asks for a gateway URL and a device API key, then stores both in
Android Keystore.

- Local debug: `adb reverse tcp:20138 tcp:20138`, then pair with `http://127.0.0.1:20138`.
- Remote: an HTTPS private tunnel or reverse proxy. Plain HTTP to a non-loopback host is rejected.
- Build: `pnpm build:android` then `pnpm android:apk` →
  `android/app/build/outputs/apk/debug/app-debug.apk`.
- Latest debug APK: `https://github.com/Hilbras/OmniHilbras/releases/latest/download/OmniHilbras-android-debug.apk`.
- QR pairing, release signing and physical-device verification are still open — see [`android/README.md`](./android/README.md).

## CLI

`omnihilbras` with no verb starts the gateway and the dashboard. With a verb it **asks a running gateway
something** — what a script or an agent needs and a page cannot give. Every verb takes `--json`, which prints
the answer as data and nothing else.

| Verb | What it does |
| --- | --- |
| `setup` | First run: what is missing, install it (showing the command first), install the `omnihilbras` command, start the servers |
| `doctor` | The same checks as a report that **changes nothing** — safe in a script or on someone else's machine |
| `status` | Is the gateway up, what version, which providers are unhealthy (`--strict` exits `1`) |
| `providers` | Every saved account: enabled, priority, credential kind, models, ejection, last error |
| `models` | The served model ids, grouped by provider prefix — what you paste into a client |
| `test` | Probe one account, or all accounts of a provider (the repository's account walk at the limit of one request) |
| `keys` | Key metadata; `--mint` creates one and prints the secret once |
| `routing` | Live routing state: failures, ejection, waits, latency, strategy (`--problems` narrows) |
| `logs` | Follow finished requests — model, provider, account, outcome, attempts, error code |

```bash
omnihilbras status
omnihilbras providers zcode
omnihilbras test zcode --json
omnihilbras routing --problems
```

Each verb calls a route the gateway already serves, so the CLI and the dashboard cannot drift into two
opinions. It has **no dependencies**, and asking what it does starts nothing: `omnihilbras help` reads a
string and exits. Full reference: [`docs/CLI.md`](./docs/CLI.md).

## Configuration

Configured by environment variables; the full list is in [`docs/SPEC-SDK.md`](./docs/SPEC-SDK.md). The ones
most people change:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIHILBRAS_HOST` | `127.0.0.1` | Loopback host; non-loopback values are refused in local mode |
| `OMNIHILBRAS_PORT` | `20138` | Gateway port |
| `OMNIHILBRAS_DATA_DIR` | XDG config | Connections, vault, usage and settings |
| `OMNIHILBRAS_REQUIRE_API_KEY` | — | Require an admin/LLM key for management and inference |
| `OMNIHILBRAS_TOKEN_SAVER` | off | Enable local context compression |
| `OMNIHILBRAS_MAX_OUTPUT_TOKENS` | none | Hard output cap |
| `OMNIHILBRAS_THINKING_BUDGET` | none | Thinking-budget cap where supported |
| `OMNIHILBRAS_HISTORY_TRIM_TOKENS` | none | Trim whole old turns above this estimate |
| `OMNIHILBRAS_CACHE_ANCHOR` | off | Re-anchor provider cache breakpoints |
| `OMNIHILBRAS_HEADROOM_URL` / `OMNIHILBRAS_PXPIPE_URL` | none | Optional external savers |
| `OMNIHILBRAS_MAX_CONNECTIONS` | 250 | How many connections a vault holds |
| `OMNIHILBRAS_MAX_METADATA_BYTES` | 4 MiB | How large the metadata file may grow |
| `OMNIHILBRAS_FAILURE_THRESHOLD` | 3 | Consecutive failures before a connection is ejected |

Secrets are read from the environment or the encrypted vault. A credential must never be committed, pasted
into an issue, or written to browser storage.

## Security and privacy

- **Loopback by default.** `OMNIHILBRAS_HOST` is validated as a loopback address in more than one place, so a
  typo or a second code path cannot widen the listener silently.
- **Encrypted vault.** Credentials are written atomically with owner-only permissions and encrypted at rest.
  Backups use AES-256-GCM with a scrypt-derived key and are unreadable without the passphrase.
- **No credential in browser storage.** Every `localStorage`/`sessionStorage` key is on a short allowlist of
  display preferences, and `sessionStorage`, `document.cookie` writes, IndexedDB and the Cache API are
  asserted at zero by a test that splits camelCase so `apiKey` cannot slip past.
- **No secret-shaped string in the tree.** Every tracked file is scanned for credential shapes on each push.
- **Fail closed on bad configuration.** A malformed cap, URL or master key is a startup error, not a silent
  fallback.
- **Optional services fail open.** Headroom and PXPIPE time out and leave the request untouched; a skipped
  saver is reported as skipped, never as a saving.

The threat model, what was audited, and the limits that remain are in [`SECURITY.md`](./SECURITY.md).

## Current state

This section exists because the rest of the file describes what *should* happen, and these are the parts that
are known not to:

- **Installers are unsigned.** Windows and macOS builds prompt on first launch, and the updater asks before
  installing anything it cannot prove. Verifying properly needs signing keys, which do not exist yet.
- **`proxyPool` has no transport.** A non-`none` pool is refused rather than ignored, so a provider that flags
  several accounts on one address cannot be fully answered from inside the app.
- **The npm package ships a bundled server** since `3.73.0`; the desktop app is the alternative.
- **The Android build is a debug shell** — no release signing, no physical-device verification yet.

## Development

```bash
pnpm install
pnpm dev              # marketing + dashboard on :20137
pnpm dev:gateway      # gateway on :20138
pnpm typecheck
pnpm test             # SDK, gateway, token-saver and repository guards
pnpm build
pnpm analyze          # per-page bundle cost, attributed per package
pnpm verify           # version, brand, typecheck, test, SPEC guard, build, bundle budget
pnpm release:audit    # every tag: pushed, released on GitHub, published to npm
pnpm audit:catalogs   # refresh saved provider catalogs; metadata reads only, no inference
pnpm benchmark:gateway --n 100   # local adapter only: gateway overhead floor
```

`pnpm verify` is the release gate: the same command CI runs, in the order that fails fastest.

### Tests are guards, not decoration

The suite is large, but the important part is what the guards assert: provider cards do not invent
measurements, credentials never reach browser storage, every served gateway route has a spec line, every tag
is on `main`, every rendered provider mark is committed, and an update feed missing `latest.yml` fails instead
of looking healthy.

A guard is not considered real until it has been **made to fail** on the thing it forbids. Several tests here
record the mutation that first proved them blind; keep that habit when adding one.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/SPEC-SDK.md`](./docs/SPEC-SDK.md) | Gateway routes, provider contract, rejection shapes and success criteria |
| [`docs/CLI.md`](./docs/CLI.md) | The `omnihilbras` verbs, their flags, the auth they use and the exit codes they return |
| [`docs/INSTALL.md`](./docs/INSTALL.md) | Installing, the first-run check, and uninstalling every version on a machine |
| [`NPM-PUBLISH.md`](./NPM-PUBLISH.md) | What is published, how, and how to confirm it actually landed |
| [`docs/architecture/README.md`](./docs/architecture/README.md) | Measured architecture, layer boundaries and provider-specific surface |
| [`docs/architecture/embeddings-plan.md`](./docs/architecture/embeddings-plan.md) | Embeddings design and dispatch rules |
| [`docs/reports/`](./docs/reports/) | Performance, reliability, release readiness and provider test reports |
| [`docs/tools.md`](./docs/tools.md) | How to run one-off probes without committing them |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | The rules a change must satisfy |
| [`SECURITY.md`](./SECURITY.md) | Reporting, threat model and known limits |
| [`AGENTS.md`](./AGENTS.md) | Working agreement, release checklist and repository boundaries |

## License

MIT. See [`LICENSE`](./LICENSE).
