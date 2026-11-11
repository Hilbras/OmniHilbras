# Release notes draft: 3.5.1

Status: 3.0.4 is a runtime fix; 3.0.3 was documentation-only. This file records the current line; the
GitHub release is the canonical source.

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
