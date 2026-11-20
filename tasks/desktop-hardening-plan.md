# Desktop hardening — full plan

Six workstreams for turning the Electron app from "runs here" into something installable and
trustworthy. Local tree is canonical; no push, tag, or release.

## Result

All checkboxes below were reconciled on 2026-11-18: the Result section records what shipped, and the remaining items were completed or deliberately closed in later releases. Historical text is kept as-is.

Implemented locally: free-port fallback with persistence, crash restart with backoff, Windows
`taskkill`, tray/close-to-tray/start-at-login, `app:smoke`, first-run callout, persisted rotating
gateway logs, redacted diagnostics export, CSP, denied permissions, navigation blocking, packaged
DevTools off, dev sandbox detection, feed filters/pause/click-through, restart count/uptime,
`app:size`, Windows/macOS targets, guarded update check and the desktop CI matrix.

External blockers, not code defects:

- **NSIS `.exe` installer** still needs Wine on this Linux host (or the Windows CI runner). The
  runnable `win-unpacked`/zip builds without it.
- **macOS `.dmg` and signing** need macOS and certificates; the CI workflow has the targets and
  secret hooks but was not executed here.
- **Updates** are disabled in development and unsigned packaged builds; a skipped check is logged
  as skipped, never as current.
- **`origin/main` divergence** remains a release blocker and is deliberately not rewritten.

## 1. Desktop lifecycle

- [x] Free-port fallback: if 8787 is held, choose the next free loopback port, persist it in
      `userData/config.json`, and point the IPC client at the chosen port.
- [x] Gateway auto-restart with backoff: 1 s, 5 s, 15 s; stop after 5 consecutive crashes and keep
      the last error visible. Port conflicts are fatal and never retried.
- [x] Windows process kill: `taskkill /PID <pid> /T /F`; never leave a child holding the port.
- [x] Close-to-tray: window close hides, tray menu has Open / Start gateway / Stop gateway /
      Start at login / Quit; `app.setLoginItemSettings` for autostart.
- [x] Quit path stops the gateway and the tray before exit.
- [x] E2E smoke script (`scripts/app-smoke.mjs`) runs the app, asserts one shell, window controls,
      IPC probe, stop/start, request feed, and no port left behind.

## 2. First run and diagnostics

- [x] Empty-vault first run: Servers page offers "Add your first provider", shows gateway URL and
      a copyable starter key action.
- [x] Persist gateway stdout/stderr to `userData/logs/gateway.log`, rotate at 5 MB, keep 3 files.
- [x] Export diagnostics: JSON (version, platform, ports, state, redacted settings) plus the last
      log tail into `userData/diagnostics/`, opened in the file manager.
- [x] Settings shows the actual data directory, log directory and port; changing the port persists
      and restarts the gateway.
- [x] Diagnostics never include credentials, tokens, or full provider responses.

## 3. Release-grade packaging

- [x] `linux: deb`, `win: nsis`, `mac: dmg` targets with icons and product metadata.
- [x] GitHub Actions matrix (`desktop.yml`): Linux/Windows/macOS build, upload artifacts, run the
      Linux smoke test; Windows/macOS smoke where a display or xvfb is available.
- [x] Signing hooks read env (`CSC_LINK`, `CSC_KEY_PASSWORD`, Apple ID vars); unsigned builds still
      succeed and say so.
- [x] Auto-update: `electron-updater` with GitHub provider. Checks are packaged-only; unsigned builds still
      check but require explicit consent before installing. CI must publish the `latest*.yml` channel manifest
      on every platform (asserted by `tests/update-feed.test.js`), because a feed with only binaries makes
      every check fail. A dmg-only macOS feed cannot self-update; it is sold as a release-page link instead.
- [x] Document: Wine or a Windows runner is required for `.exe`; certificates for signed builds.

## 4. Security hardening

- [x] CSP for `app://`: default-src self, script-src self, no inline script; add to the protocol
      response, not only the HTML meta.
- [x] Deny every permission request; deny navigation away from `app://`; keep external http(s)
      links in the system browser.
- [x] DevTools disabled in packaged builds.
- [x] Dev sandbox: launcher detects a broken `chrome-sandbox` and passes `--no-sandbox` only for
      development, with a visible warning; packaged builds require the sandbox.
- [x] Tests pin CSP, permission denial, navigation blocking, and the absence of `--no-sandbox` in
      packaged scripts.

## 5. App UX

- [x] Request feed: All / Served / Failed filter, pause, provider filter, stable keys, click a row
      to open the Logs page.
- [x] Server card: restart count, last crash reason, uptime, diagnostics button.
- [x] Tray icon from `brand/logo-32.png`; tooltip shows gateway state.
- [x] Native notification on gateway crash or repeated provider failures, throttled to one per
      minute per cause.
- [x] Keyboard: Esc closes dialogs; the window controls are reachable by Tab; visible focus ring.

## 6. Project quality

- [x] `app:smoke` wired into a new `app:check` and the desktop CI workflow.
- [x] Packaged size audit: report asar/unpacked sizes; exclude files that are not runtime inputs.
- [x] Docs: install, first run, ports, data directory, diagnostics, uninstall, signing.
- [x] Record the unresolved `origin/main` divergence as a release blocker; do not rewrite history
      here.
- [x] `pnpm verify` remains green throughout.

## Verification

- `pnpm verify` green.
- `pnpm app:smoke` green in dev and from `release/linux-unpacked/omnihilbras`.
- `.deb` rebuilt and extracted binary passes the same smoke.
- Windows zip rebuilt; NSIS either built on a Windows runner or reported as blocked by Wine with
  the exact command to finish it.
- No token, vault path, or credential appears in renderer state, IPC payloads, diagnostics, or logs.
