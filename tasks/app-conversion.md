# Desktop app conversion — plan

Goal: run OmniHilbras as a desktop app. Electron main owns the gateway lifecycle; the main page
is server controls plus the live request log. The renderer keeps the existing dashboard pages but
never holds the dashboard token and never calls the gateway directly.

Decision: **Electron**, because the gateway is Node/TypeScript and the existing launcher already
knows how to own process groups. Tauri would need a Node sidecar and duplicate process control.

## Result

Phase A–D implemented. `app:dev` builds and opens the app; the main process starts the gateway and
the Servers page shows its state, process output and live request feed. `app:build` produces
`release/linux-unpacked/omnihilbras` from `app://omnihilbras`; the packaged smoke run starts the
gateway, answers through IPC, and stops/restarts it without leaving port 8787 held. `pnpm verify`
remains the release gate. Phase E evidence is the smoke run and the supervisor/IPC tests.

## Architecture

```
Electron main
├─ desktop/main.mjs          app lifecycle, BrowserWindow, app:// protocol
├─ desktop/supervisor.mjs    gateway child: start/stop/restart, ports, readiness, log ring
├─ desktop/gateway-ipc.mjs   loopback request + SSE proxy, token stays in main
└─ desktop/preload.mjs       contextBridge: server, logs, gateway

renderer (existing src/)
├─ src/lib/electronBridge.ts transport selection (browser vs app)
├─ src/pages/AppHomePage.tsx server controls + process log + request feed
└─ src/lib/gatewayClient.ts  requestJson/stream/log stream use the bridge when present
```

Security rules:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Preload exposes a fixed API; no raw `ipcRenderer`.
- Main reads the per-launch dashboard token; renderer never sees it.
- Main attaches `Origin` for the app dashboard and the token header to every proxied call.
- IPC validates method/path against an allowlist of gateway routes; no arbitrary URLs.
- Renderer CSP blocks remote script; fonts remain the only remote resource.

## Phase A — Desktop shell and supervisor

- [ ] Add `electron` and `electron-builder` as devDependencies.
- [ ] `desktop/supervisor.mjs`: spawn `Kernel/API/dist/src/main.js` with the Electron Node runtime,
      choose ports, wait for `/health` (TCP + HTTP), ring-buffer stdout/stderr, stop with SIGTERM,
      restart on demand, emit `starting|running|stopped|failed`.
- [ ] `desktop/main.mjs`: single-instance lock, window, dev vs packaged URL, quit stops the gateway,
      second launch focuses the window.
- [ ] `desktop/preload.mjs`: `window.omnihilbras = { server, logs, gateway }`.
- [ ] `package.json` scripts: `app:dev`, `app:build` (compile gateway + frontend, then
      `electron-builder --dir`), `app:pack` (installers).
- [ ] Tests: supervisor state machine, port conflict, readiness timeout, restart, log ring bound.

## Phase B — Gateway over IPC

- [ ] `desktop/gateway-ipc.mjs`:
      - `request(method, path, body)` → status + text; attaches token and Origin.
      - `stream(path, body)` → chunks over IPC for chat SSE.
      - `logs()` → parses `/v1/logs/stream`, forwards parsed events.
- [ ] Route allowlist: `/v1/*` paths already served by the client, no absolute URLs.
- [ ] `src/lib/electronBridge.ts`: typed access to `window.omnihilbras`, feature-detected.
- [ ] `gatewayClient.ts`: `requestJson`, `streamGatewayChat`, `openGatewayLogStream` select the
      bridge in the app and keep the browser implementation for `pnpm dev`.
- [ ] Tests: renderer source has no `dashboard-token`, no direct `127.0.0.1` fetch in app path;
      IPC allowlist rejects unknown paths and methods.

## Phase C — Main page

- [ ] `src/pages/AppHomePage.tsx`:
      - server card: state, dashboard/gateway ports, health, Start/Stop/Restart, data directory.
      - process log: last N stdout/stderr lines, auto-scroll toggle, copy.
      - request feed: the same events as the Logs page, with outcome/latency.
- [ ] Route `/` → `AppHomePage`; sidebar entry “Servers” first; remove the dead “Request log”
      pending entry.
- [ ] `/logs` keeps the request-only view; the main page combines both.
- [ ] Browser dev fallback: when there is no bridge, the page says the gateway is managed by
      `pnpm dev:gateway` and shows the browser log stream.

## Phase D — Packaging and app protocol

- [ ] Register privileged `app://omnihilbras` protocol; serve `dist/` with SPA fallback to
      `dist/dashboard.html`, correct MIME types, traversal refused.
- [ ] `BrowserRouter` keeps basename `/dashboard` under the app origin.
- [ ] electron-builder config: app id, product name, icons from `brand/`, files `desktop/**`,
      `dist/**`, `Kernel/API/dist/**`; gateway data dir is `app.getPath('userData')`.
- [ ] First-run: data dir created 0700; no credentials in the app bundle.
- [ ] Verify unpacked build opens the main page with the gateway stopped, then starts it.

## Phase E — Verification

- [ ] `pnpm verify` still green.
- [ ] `pnpm app:dev` launches the app, starts the gateway, main page shows `running`.
- [ ] Stop/restart leaves no orphan process and the port is reusable.
- [ ] Request log events arrive through IPC; chat streaming arrives through IPC.
- [ ] Packaged app (`app:build`) opens, starts the gateway, and serves the dashboard from
      `app://omnihilbras/dashboard/`.
- [ ] No token, vault path, or credential appears in renderer state or IPC payloads.

## Deliberate non-goals (first version)

- Auto-update, code signing, notarisation, tray/menu-bar mode.
- Multiple simultaneous gateways or remote gateway URLs.
- Moving the vault into Electron safeStorage; the existing encrypted vault stays the source.
- Replacing the browser dashboard; both modes share one renderer.
