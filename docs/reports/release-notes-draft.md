# Release notes draft: 3.8.0

Status: 3.0.4 is a runtime fix; 3.0.3 was documentation-only. This file records the current line; the
GitHub release is the canonical source.

## 3.8.0 — DeepSeek Web full agent

- DeepSeek Web now parses prompt-level DSML into OpenAI `tool_calls`, in both non-streaming and streaming turns, with multi-round tool-result replay.
- Added image attachments: data URIs and safe `https:` URLs, 8 MB each, four per turn, uploaded through `/api/v0/file/upload_file` and referenced in `ref_file_ids`.
- Long histories are compacted after 60,000 characters while the newest turn stays intact.
- Chat sessions are reused for 15 minutes, keyed by a userToken hash and bounded at 100 entries.
- Image-URL fetches reject localhost, link-local, private and metadata ranges.
- The adapter keeps the audited pure-JS PoW solver; the old project's opaque WASM binary was not imported.

## 3.7.1 — DeepSeek Web parity fixes

- DeepSeek Web accepts `stream: true` again and returns the completed answer as one SSE chunk, matching the old executor's honest one-chunk behavior.
- Restored token usage from DeepSeek's `accumulated_token_usage` metadata; the prompt side is marked estimated and the output side uses the provider's count.
- Restored `reasoning_content` on OpenAI-shaped completions, and fixed the adapter to use the contract's `reasoning` field.
- Rejected a pasted HTTP request line as a userToken instead of treating it as a credential.
- Restored the generic body-refusal reader used by the old shared module.

## 3.7.0 — Perplexity Web and Grok Web

- Added `perplexity-web`: the seven `pplx-*` modes over Perplexity's SSE ask endpoint, with reasoning/search blocks, citation cleanup and a bounded follow-up session cache.
- Added `grok-web`: the twelve old-registry Grok modes over the web conversation NDJSON endpoint, with the model-mode map and browser-fingerprint headers.
- Both are API-key cards under **Web Cookie Providers**, with high-severity whole-account session warnings, committed logos, check/connect routes and model-prefix ids `pw/` and `gw/`.
- Both adapters forward real streaming chunks. The existing six web-cookie providers remain explicitly non-streaming; `stream: true` returns `NOT_SUPPORTED`, and the spec table says which provider produces chunks.
- Checks run before saves: a rejected cookie is not stored, and a 400/429 from the deliberately small probe means the cookie was accepted rather than dead.

## 3.6.0 — live host load and two more free-tier providers

- Added `GET /v1/system`: a measured CPU percentage over a short interval, plus host memory and uptime.
- The Servers page polls it every two seconds and shows CPU and memory bars with cores, load average and used/total memory.
- The route is management-gated, so a paired Android device or remote browser can read the gateway host's load.
- The sample contains no hostname, credential or request content.
- Added AgentRouter and Aion Labs to **Free Tier Providers**. Both are API-key cards with their vendors' own marks and OpenAI-compatible endpoints: `https://agentrouter.org/v1` and `https://api.aionlabs.ai/v1`.
- Aion Labs advertises a free daily credit allowance at 15 requests and 20,000 tokens per minute; AgentRouter advertises free developer credits with a capacity-dependent model list. Neither card claims a model count before the gateway reads one.

## 3.5.1 — Android pairing verified

- Keystore pairing worked on an Android 35 emulator.
- Providers, Models, Routing, Usage and Logs loaded through `adb reverse` with no overflow.
- Loopback HTTP is allowed by a network-security config; remote URLs remain HTTPS-only.

## 3.5.0 — Android companion debug shell

- Added a Capacitor Android shell with a dashboard-only build and debug APK.
- Android setup accepts a gateway URL and device API key, stored through an Android Keystore-backed plugin.
- Remote gateway URLs must be HTTPS; plain HTTP remains loopback-only.
- Added the Capacitor origin to the default CORS allowlist.
- QR pairing, release signing and physical-device verification remain open.

## 3.4.0 — virtual models

- Added `oh/` virtual models: one public id routed to several saved accounts and upstream models.
- Added `/dashboard/models` cards and editor, plus the `/v1/virtual-models` management API.
- Enabled virtual models appear in `/v1/models` with `virtual: true` and providers.
- Priority, round-robin and fastest strategies; upstream model override; auth isolation and account limits apply per target.

## 3.3.1 — GitHub star buttons

- Added a GitHub star action to the navbar and the hero.

## 3.3.0 — explicit account isolation

- Provider page calls each saved connection an account and shows its email.
- `x-omnihilbras-connection` narrows routing to one account; unknown and disabled accounts are refused.
- Authentication failures stop at that account; they never retry on another.
- Per-account `maxConcurrentRequests` and existing `requestsPerMinute` are independent.
- Usage can be filtered by account, and the provider Usage tab has an account selector.
- A named `proxyPool` is refused because this build has no proxy transport; it is never sent direct.

## 3.2.0 — .deb updates from the app

- A Linux `.deb` install can now download its update, verify the checksum, and open the system installer
  from Settings. The package manager still asks for administrator permission; a system package cannot
  bypass that.
- AppImage, Windows and macOS keep the direct install path.

## 3.1.0 — Linux AppImage updates

- Linux releases now include `OmniHilbras-linux-amd64.AppImage`.
- The AppImage can download and install its own updates; the `.deb` remains a manual install.
- Download page and README list the AppImage as the primary Linux build.

## 3.0.5 — notifications below the header

- Toasts no longer cover the navbar, theme switch or window controls; they sit below the 72 px header.
- No gateway route changed.

## 3.0.4 — test every saved connection

- The provider page's Test button now probes every saved connection instead of only the first one and
  reports each result on its own row.
- No gateway route changed.

## 3.0.3 — documentation

- Rewrote `README.md` as a product overview: install, architecture, gateway routes, providers, token saver,
  dashboard, desktop, configuration, security and development.
- Added `docs/README.md` as the documentation index.
- Updated the gateway specification's status and module map for the Kernel restructure.
- Updated the architecture overview with the current delivery surfaces.
- Updated contributing commands and the security reporting path.
- Moved the marketing HTML entries under `site/`; the project root now contains only `index.html` and
  `dashboard.html`.
- No runtime behavior changed in this release.

## 3.0.2 — desktop update and sign-in fixes

## Desktop app

- The Windows and Linux installers are built with stable artifact names:
  `OmniHilbras-Setup.exe` and `OmniHilbras-linux-amd64.deb`.
- A tagged desktop build now attaches the installers, blockmaps and update metadata (`latest*.yml`) to the
  GitHub release.
- Update install stops the gateway first and bypasses the ordinary deferred-quit path, so the installer does
  not race a process that still holds the app directory.
- `autoInstallOnAppQuit` is off: an update installs only from the explicit **Install and restart** action.
- Provider sign-in opens in the default browser through `shell:open-external`. The desktop shell still denies
  `window.open`; the bridge exists so a sign-in does not require a second click on a fallback link.
- The mobile navigation is an overlay below the header, not an in-flow panel that pushes the page down.

## Gateway and token saver

- Cache-aware token accounting across the gateway and provider adapters: cache reads and writes are kept
  separate from prompt tokens and priced as cache.
- Token Saver: RTK filters, reversible compression, per-saver telemetry, history trimming, output and
  thinking caps, `count_tokens`, Anthropic cache anchoring, and optional Headroom/PXPIPE savers.
- Optional external savers fail open, time out, and report `ran` or `skipped` with a reason.
- The gateway remains provider-neutral; PXPIPE is gated by an adapter capability, not a provider id.

## Dashboard, marketing and documentation

- Marketing pages: Home, Download, Docs, Pricing, About, Changelog, Security and Privacy.
- `site/` holds the static HTML entries; clean URLs are served by rewrites.
- Each page has a unique title, description, canonical URL, Open Graph/Twitter tags and JSON-LD.
- `sitemap.xml`, `robots.txt`, `manifest.webmanifest` and a 1200×630 Open Graph image are published.
- The README is now a product overview; engineering references live under `docs/`.

## Upgrade

- Windows: the app downloads `OmniHilbras-Setup.exe` from the latest release and installs it from Settings →
  Updates.
- macOS: the `.dmg` is built on macOS CI; installation follows the same update path where the build is signed.
- Linux: a `.deb` cannot replace itself. The app links to the release page; install the new package with
  `sudo apt install ./OmniHilbras-linux-amd64.deb`.

## Verification

`pnpm verify` is the release gate. The desktop workflow builds Windows, Linux and macOS and attaches the
installers and update metadata to the tag release.
