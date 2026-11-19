# CLI experience improvement plan — 9router parity, on our terms

**Created:** 2026-11-19 · **Baseline:** `3.74.1` (the installed-dashboard fix) · **Status:** starting Phase 1.

## Goal

Make the installed `omnihilbras` command as convenient to **run, control, update and read** as the
reference launcher (`/mnt/sda3/work/projects.old/9router`), **without giving up the properties this
project deliberately chose**. Concretely: a person who runs `npm i -g @hilbras/omnihilbras` should be
able to start the servers, see their state at a glance, open the dashboard, stop/restart them, run them
in the background, and learn when an update exists — all from the terminal, with zero runtime
dependencies and no install-time network or native build.

The comparison that motivates this is recorded in the conversation of 2026-11-19 (install / CLI work /
commands / run / UI design). 9router puts a full TUI + tray + auto-update in the terminal; we put the
management UI in the **dashboard** and keep the CLI a thin, scriptable client. This plan closes the
*convenience* gap while keeping that split.

## Non-negotiables (deliberate divergences we KEEP)

These are not gaps to fix; adopting 9router here would be a regression. Each phase must preserve them.

1. **Loopback-only by default.** 9router binds `0.0.0.0` and warns. We bind `127.0.0.1`. No phase changes
   the default bind; LAN exposure stays an explicit opt-in (`OMNIHILBRAS_CONTAINER=1` / `--host`).
2. **Zero runtime dependencies.** No `enquirer`, no native tray binary, no `systray2`. Menus/spinners/tables
   stay hand-rolled. A GUI tray is **declined** (unsigned native binaries + antivirus false positives are
   exactly what 9router's own comments fight); background mode is achieved by detaching, not a tray.
3. **No install-time bootstrap.** 9router's `postinstall` downloads SQLite/tray into `~/.9router/runtime`.
   Our `prepack` bundles everything; `npm i -g` stays a pure file copy. We do **not** add a postinstall.
4. **JSON-first, colour-for-people.** Every new verb honours `--json` (the whole answer) and drops colour
   off-TTY / `NO_COLOR`. The dashboard remains the management UI; we do not build a nested CRUD TUI.
5. **Refuse, never kill, a foreign port holder.** Lifecycle control verifies a process is *ours* before
   signalling it, and never kills something it did not start.
6. **One definition per fact.** The bundled pid-file path, ownership check and token path are shared
   between the launcher and the verbs, with a test pinning they agree (the repo's recurring drift lesson).

## Phases (each ships completely: verify → bump → tag → release → npm → audit)

### Phase 1 — Lifecycle control verbs  *(target 3.75.0, new capability)*
The biggest convenience gap: today the only way to stop the bundled servers is Ctrl-C in the launcher's
terminal, and there is no way to open the dashboard or inspect the run from another shell.
- New `cli/lib/bundled-state.mjs`: the **single** definition of the bundled record path
  (`$XDG_STATE_HOME/omnihilbras/bundled.json`, mirroring `main.mjs`), read/write/clear, per-pid command-line
  lookup, liveness, and an **ownership-verified** stop. `cli/server-src/main.mjs` is refactored to import it
  so launcher and verbs cannot drift.
- New verbs (local process control, not gateway HTTP):
  - `omnihilbras stop` — stop the recorded gateway + dashboard, verifying each pid is still ours; refuse a
    reused/foreign pid; clear the record; `--json`.
  - `omnihilbras restart` — stop, then start the bundled launcher again.
  - `omnihilbras open` — open the recorded dashboard URL in the browser (falls back to a clear "not running"
    message, never a guessed port).
  - `omnihilbras ps` — is the bundled launcher running, its pids/ports/uptime/ownership, plus gateway health.
- **Acceptance:** a real bundled run can be `ps`/`open`/`stop`/`restart`ed from a second shell; a fabricated
  foreign pid is refused; `--json` works; tests drive a real launcher and a fabricated process table.

### Phase 2 — Launcher UX: arrow-key menu + live status header  *(target 3.76.0)*
- Replace the numbered `[1] open [2] restart [3] exit` prompt with a **zero-dependency arrow-key menu**
  (readline keypress, reverse-video highlight, up/down/enter/esc), mirroring 9router's `selectMenu` but with
  no `enquirer`. Non-TTY keeps a plain numbered fallback so scripts/`--log` are unaffected.
- A **live status header** above the menu: dashboard URL, gateway URL, gateway health dot, version, and
  key/enforcement state — painted from cache, refreshed in the background (9router's SWR header idea).
- **Acceptance:** TTY arrow navigation works; non-TTY unchanged; header reflects a real gateway; unit tests
  for the renderer + header against a fabricated gateway; `tests/ui-performance`-style guards unaffected.

### Phase 3 — Background / detach mode + supervised restart  *(target 3.77.0)*
- `omnihilbras --background` (alias `--detach`): start the bundled servers detached, write the record, return
  immediately; `omnihilbras stop` ends them. This is our dependency-free answer to 9router's tray.
- **Supervised restart with backoff** (cap restarts, reset the counter after the process stays up ~30s),
  mirroring 9router's `MAX_RESTARTS`/`RESTART_RESET_MS`, so a crash loop is bounded and reported.
- **Acceptance:** background start→`ps`→`stop` round-trips; the detached run survives the launching shell;
  restart backoff is tested; ownership still verified before any signal.

### Phase 4 — Update awareness (opt-in, never silent)  *(target 3.78.0)*
- On launcher start (and in `doctor`/`ps`), check `registry.npmjs.org/@hilbras/omnihilbras/latest` **in
  parallel, short timeout, fail-open**; if newer, print one line + the upgrade command. `--skip-update`
  parity. Offline/error never blocks or fails startup.
- `omnihilbras update` — **opt-in** verb that runs `npm i -g @hilbras/omnihilbras@latest` and reports the
  result. We do **not** auto-execute an upgrade or auto-relaunch the way 9router does; the person asks.
- **Acceptance:** notice appears only when newer (mock registry); never blocks startup; fail-open offline;
  `update` is explicit; tests mock the registry and the npm call.

### Phase 5 — Doctor polish + docs  *(target 3.78.x / 3.79.0)*
- Extend `doctor`: bundled server present, Node version, ports free-or-owned, dashboard token readable,
  optional `playwright-core` presence — each with an actionable next step.
- Docs: `docs/CLI.md` + README CLI section cover every new verb/flag and background mode; record **why** we
  keep the non-negotiables (so a future contributor does not "fix" loopback or add a postinstall).
- **Acceptance:** `doctor` reports real state; docs match the shipped verbs; `pnpm verify` green; audit clean.

## Versioning & definition of done
Per `AGENTS.md`: each phase is a behaviour change → bump (new verbs/modes = minor `0.x.0`; refinements =
patch), `pnpm version:fix`, `pnpm verify`, commit on `main`, tag `v<version>`, push, GitHub release with
what-changed + how-to-verify, `npm publish --access public` from `cli/`, confirm `npm view …@<version>
version`, and `pnpm release:audit` clean. New gateway routes (none expected — these are client-side) would
need a `docs/SPEC-SDK.md` line + `Kernel/API/test/` coverage; the `gateway-routes` guard enforces it.

## Execution log
- **Phase 1 — complete in the tree (3.75.0).** `cli/lib/bundled-state.mjs` is the single record-path +
  ownership definition; `cli/server-src/main.mjs` imports it (no inline re-declaration). New verbs
  `stop`/`restart`/`open`/`ps` registered in `cli/index.mjs`. `tests/cli-lifecycle.test.js` (8 cases: ownership
  decision, foreign-pid refusal, force override, path agreement, verb registration) and the extended
  `scripts/smoke-cli-server.mjs` (real `ps`→`stop` round-trip, record cleared) pass. `docs/CLI.md` updated.
