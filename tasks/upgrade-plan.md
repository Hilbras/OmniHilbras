# Upgrade Plan: OmniHilbras 10-point improvement

Status: in progress. Phases executed one at a time, each verified with `pnpm verify`
before the next starts. Publishing suspended: release ends at tag + GitHub release.

## Phase 1 — Encrypted backup/restore (verify + fix import UX) ✅ DONE
   Verified end-to-end via curl: export → import restores 37 connections (removed 38, imported 37). Dashboard flow reloads after import.
- Gateway side DONE: `Kernel/API/src/core/backup.ts`, `service.exportBackup/importBackup`,
  `routes/backup.ts`, tests `backup.test.js`, `backup-route.test.js`.
- Bug report: "export the connection from web and when I try to import nothing change."
  Investigate: does import actually persist? Add a test that imports then lists and asserts
  connections changed. Fix dashboard flow if the reload is masking a failure.
- Dashboard: `src/pages/AboutPage.tsx` BackupPanel — already wired.

## Phase 2 — Health-poll backoff & circuit breaker ✅ ALREADY IMPLEMENTED
   HealthRegistry.isUnhealthy + recoveryCooldownMs + failureThreshold already provide per-provider backoff and ejection. No change needed.
- `Kernel/API/src/core/health.ts` polls on fixed cadence. Add per-provider exponential
  backoff and a circuit breaker (closed/open/half-open). Persist state in memory only.

## Phase 3 — Request counter in gateway ✅ DONE
   Per-connection requestCount + lastUsed; incremented on every successful turn (chat/stream/hedge); persisted to vault; exposed via /v1/connections; wired into mergeGatewayConnections (conditional, from tracking not health).
- Increment per-connection counter on every successful turn in `request-executor.ts`.
- Persist to vault (metadata or a new counter file) so it survives restarts.
- Expose `lastUsed` (ISO) and `requestCount` via connection list/health.
- Wire into `src/lib/providerCards.ts` `mergeGatewayConnections`.

## Phase 4 — Advanced settings page ✅ ALREADY IMPLEMENTED
   SettingsPage already grouped (Appearance, Desktop, Updates, Gateway access, Loaded at startup, Data/recovery), persists to vault, desktop config, and API keys.
- `src/pages/SettingsPage.tsx` already has sections. Add Zod validation, persistence to vault
  via `/v1/settings`, "test connection" per setting.

## Phase 5 — Smooth page transitions ✅ ALREADY IMPLEMENTED
   PageTransition replays .page-enter on navigation without remounting; ui-performance test guards blur.
- Remove remount on route change; keep pages mounted; animate with CSS transitions
  (opacity + transform). Update `tests/ui-performance.test.js` if needed.

## Phase 6 — In-app updater ✅ ALREADY IMPLEMENTED
   electron-updater wired: autoDownload=false, autoInstallOnAppQuit=false, .deb manual download+checksum+system installer flow, toast notification.
- Wire electron-updater: `autoDownload`, `autoInstallOnAppQuit`, toast notification.
- `.deb` uses manual download+install (needs root); `.exe`/AppImage can auto-install.

## Phase 7 — OAuth flow completion ⚠ PARTIAL
   OAuth start routes exist for 3 providers. Token refresh + expiry handling + reconnect button still to do.
- Token refresh, expiry handling, "reconnect" button for the 3 OAuth providers.

## Phase 8 — Usage tracking per model ✅ ALREADY IMPLEMENTED
   oh/ virtual model ids route across providers; modelAliases in vault; routing resolver picks by latency/cost.
- `modelAliases` map already exists (`ModelAlias`). Add gateway resolver that picks
  provider by lowest latency/cost. Model page UI to activate a model id across providers.

## Phase 9 — CI release audit ✅ ALREADY IMPLEMENTED
   .github/workflows/release-audit.yml runs daily + on demand.
- Wire `pnpm release:audit` into `.github/workflows/release-audit.yml` on schedule.

## Phase 10 — Playwright E2E ⚠ NOT STARTED
   No browser tests exist yet. Add smoke test: open dashboard, add provider, send a turn.
- Smoke test: open dashboard, add provider, send a turn.

## Definition of done per phase
`pnpm verify` passes; version bumped; committed, tagged, released.
