# Desktop packaging decision (2026-11-27)

**Measured:** `node_modules/electron/dist` is **275 MB** on Linux x64 for Electron 45.2.3, the shell
`desktop/` itself is 100 KB of main/preload/supervisor code, and the gateway is bundled separately
inside the app. The unpacked application is therefore dominated by Chromium, not by this project.

**Options considered**

1. **Keep Electron, trim the distribution.** Remove unused locales (`--locales`), keep the existing
   ASAR packaging, and measure the effect per platform. Cheap, reversible, keeps the current
   auto-updater, tray and IPC.
2. **A Tauri shell.** A system WebView instead of a bundled Chromium would cut the dominant cost,
   but it replaces the main process, the updater, the tray integration and the preload/IPC bridge —
   the parts with the most platform-specific behaviour and the least test coverage.
3. **A browser-first PWA.** The dashboard already has a web manifest; 4.5 adds an offline shell.
   This serves users who do not need OS integration, but it is not a replacement for the desktop app
   for the users who do.

**Decision: option 1 for 4.5, option 3 shipped alongside.** A Tauri rewrite is a separate decision
with its own measurement, and doing it inside a capability release would put the updater and IPC
surface at risk for a packaging win. The measurable target for a later release is the unpacked size
after locale pruning, not a rewrite.

**This is not a claim that 275 MB is acceptable** — it is the measured cost of the current choice,
recorded so the next decision starts from a number.
