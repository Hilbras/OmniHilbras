# Desktop hardening — full plan

Six workstreams for turning the Electron app from "runs here" into something installable and
trustworthy. Local tree is canonical; no push, tag, or release.

## 1. Desktop lifecycle

- [ ] Free-port fallback: if 8787 is held, choose the next free loopback port, persist it in
      `userData/config.json`, and point the IPC client at the chosen port.
- [ ] Gateway auto-restart with backoff: 1 s, 5 s, 15 s; stop after 5 consecutive crashes and keep
      the last error visible. Port conflicts are fatal and never retried.
- [ ] Windows process kill: `taskkill /PID <pid> /T /F`; never leave a child holding the port.
- [ ] Close-to-tray: window close hides, tray menu has Open / Start gateway / Stop gateway /
      Start at login / Quit; `app.setLoginItemSettings` for autostart.
- [ ] Quit path stops the gateway and the tray before exit.
- [ ] E2E smoke script (`scripts/app-smoke.mjs`) runs the app, asserts one shell, window controls,
      IPC probe, stop/start, request feed, and no port left behind.

## 2. First run and diagnostics

- [ ] Empty-vault first run: Servers page offers "Add your first provider", shows gateway URL and
      a copyable starter key action.
- [ ] Persist gateway stdout/stderr to `userData/logs/gateway.log`, rotate at 5 MB, keep 3 files.
- [ ] Export diagnostics: JSON (version, platform, ports, state, redacted settings) plus the last
      log tail into `userData/diagnostics/`, opened in the file manager.
- [ ] Settings shows the actual data directory, log directory and port; changing the port persists
      and restarts the gateway.
- [ ] Diagnostics never include credentials, tokens, or full provider responses.

## 3. Release-grade packaging

- [ ] `linux: deb`, `win: nsis`, `mac: dmg` targets with icons and product metadata.
- [ ] GitHub Actions matrix (`desktop.yml`): Linux/Windows/macOS build, upload artifacts, run the
      Linux smoke test; Windows/macOS smoke where a display or xvfb is available.
- [ ] Signing hooks read env (`CSC_LINK`, `CSC_KEY_PASSWORD`, Apple ID vars); unsigned builds still
      succeed and say so.
- [ ] Auto-update: `electron-updater` with GitHub provider, disabled unless the build is signed and
      a release feed exists; never claim an update check succeeded when it was skipped.
- [ ] Document: Wine or a Windows runner is required for `.exe`; certificates for signed builds.

## 4. Security hardening

- [ ] CSP for `app://`: default-src self, script-src self, no inline script; add to the protocol
      response, not only the HTML meta.
- [ ] Deny every permission request; deny navigation away from `app://`; keep external http(s)
      links in the system browser.
- [ ] DevTools disabled in packaged builds.
- [ ] Dev sandbox: launcher detects a broken `chrome-sandbox` and passes `--no-sandbox` only for
      development, with a visible warning; packaged builds require the sandbox.
- [ ] Tests pin CSP, permission denial, navigation blocking, and the absence of `--no-sandbox` in
      packaged scripts.

## 5. App UX

- [ ] Request feed: All / Served / Failed filter, pause, provider filter, stable keys, click a row
      to open the Logs page.
- [ ] Server card: restart count, last crash reason, uptime, diagnostics button.
- [ ] Tray icon from `brand/logo-32.png`; tooltip shows gateway state.
- [ ] Native notification on gateway crash or repeated provider failures, throttled to one per
      minute per cause.
- [ ] Keyboard: Esc closes dialogs; the window controls are reachable by Tab; visible focus ring.

## 6. Project quality

- [ ] `app:smoke` wired into a new `app:check` and the desktop CI workflow.
- [ ] Packaged size audit: report asar/unpacked sizes; exclude files that are not runtime inputs.
- [ ] Docs: install, first run, ports, data directory, diagnostics, uninstall, signing.
- [ ] Record the unresolved `origin/main` divergence as a release blocker; do not rewrite history
      here.
- [ ] `pnpm verify` remains green throughout.

## Verification

- `pnpm verify` green.
- `pnpm app:smoke` green in dev and from `release/linux-unpacked/omnihilbras`.
- `.deb` rebuilt and extracted binary passes the same smoke.
- Windows zip rebuilt; NSIS either built on a Windows runner or reported as blocked by Wine with
  the exact command to finish it.
- No token, vault path, or credential appears in renderer state, IPC payloads, diagnostics, or logs.
