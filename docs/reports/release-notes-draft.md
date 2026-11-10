# Release notes draft: 3.0.3

Status: documentation-only release. The previous runtime release was `v3.0.2`; this file records both the
3.0.2 changes and the documentation rewrite that followed.

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
