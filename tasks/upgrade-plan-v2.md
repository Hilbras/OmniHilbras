# Upgrade Plan v2 — OmniHilbras

Goal: ship the next round of reliability, UX, provider, and DX upgrades.

## Phases

### Phase A — Encrypted backup/restore (verify import UX)
- Verify import persists connections (curl test: export → import → list).
- Fix dashboard import flow if reload masks failure.
- Add test: import then list, assert connections changed.

### Phase B — Health-poll backoff & circuit breaker
- Per-provider exponential backoff in HealthRegistry.
- Circuit breaker (closed/open/half-open) state machine.
- In-memory only; persist nothing.

### Phase C — Request counter wiring
- Confirm per-connection counter increments on every successful turn.
- Wire lastUsed + requestCount into mergeGatewayConnections (already partially done).
- Add test asserting real usage shows on cards.

### Phase D — Advanced settings page
- Zod validation on all settings.
- Persist to vault via /v1/settings.
- "Test connection" per setting.

### Phase E — Smooth page transitions
- Keep pages mounted across route changes.
- CSS transitions (opacity + transform).
- Update ui-performance test if needed.

### Phase F — In-app updater
- Wire electron-updater autoDownload/autoInstallOnAppQuit.
- .deb manual download+install flow; .exe/AppImage auto-install.
- Toast notification on update available.

### Phase G — OAuth flow completion
- Token refresh + expiry handling for 3 OAuth providers.
- Reconnect button on connection rows.

### Phase H — Usage tracking per model
- modelAliases map in vault (exists).
- Gateway resolver picks provider by lowest latency/cost.
- Model page UI to activate a model id across providers.

### Phase I — CI release audit
- Schedule release:audit in GitHub Actions (exists).
- Verify daily run.

### Phase J — Playwright E2E
- Smoke test: open dashboard, add provider, send turn.
- Run in CI with chromium install.

### Phase K — Performance
- Bundle budget tightening.
- Lazy-load heavy pages.

## Definition of done
pnpm verify passes; committed, tagged, pushed, GitHub release created.
"