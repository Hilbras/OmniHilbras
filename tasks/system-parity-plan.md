# System Parity Plan — OmniHilbras (vs. old2 / 9router-style)

Goal: close the system-level gaps between the current OmniHilbras (gateway + dashboard + desktop + Android) and the old2 reference (Next.js router/proxy), so the current product keeps the multi-surface advantages while regaining the routing, tooling, media, and extensibility features old2 had. Provider/model counts are out of scope; system capabilities are in scope.

## Phases

### Phase 1 — Combos (model combos)
- Add a `combos` store in the vault (name → ordered list of connection/model refs with strategy).
- Gateway route `GET/POST/PUT/DELETE /v1/combos`; resolve a combo id in inference like a virtual model.
- Dashboard: Combos page to create/edit/activate a combo.
- Test: combo resolves to first healthy member; failover to next.

### Phase 2 — Multi-account fallback + quota tiers
- Port `accountFallback` logic: round-robin + cooldown per account, quota tracking.
- Auto-fallback tiers (subscription → cheap → free) with configurable tier per connection.
- Usage/quota counters per connection; surface in cards.
- Test: exhausted account is skipped; tier fallback exercised.

### Phase 3 — Format translation direct routes
- Translator registry with direct `source:target` pairs (OpenAI pivot today) so fragile pairs skip the lossy double-hop.
- Reuse schema/concerns; register via side-effect imports.
- Add direct routes for claude↔kiro, claude↔cursor at minimum.
- Test: direct route chosen when registered; pivot otherwise.

### Phase 4 — RTK parity
- Per-tool filters + autodetect (port from old2 `rtk/filters`).
- Headroom proxy compress integration.
- Caveman / ponytail system-prompt injectors (fail-open).
- Telemetry in token-saver stats.
- Test: compression applied; fail-open on error.

### Phase 5 — Media providers
- Handlers for image, TTS, STT, search, embedding, video (OpenAI-compatible where possible).
- Routes `/v1/images/*`, `/v1/audio/*`, `/v1/embeddings`, search endpoint.
- Dashboard: media test panels.
- Test: each handler streams/returns correctly with a mock upstream.
- **Slice 1 (image generation) — DONE (v3.13.0):** `POST /v1/images/generations`, openai adapter `image()`, failover via `imageWithFailover`, NOT_SUPPORTED on chat-only providers, spec line + 5 tests.

### Phase 6 — MCP server
- `/api/mcp` (or `/v1/mcp`) exposing tools/resources over MCP protocol.
- Auth via gateway api key.
- Test: initialize + list tools.

### Phase 7 — Tunnel
- Server-side tunnel endpoint to expose gateway over HTTPS (integration with a tunnel provider).
- Dashboard toggle + status.
- Test: tunnel start/stop mocked.

### Phase 8 — Skills system
- Skill registry + `/api/skills` CRUD; skill index build script.
- Dashboard: skills page.
- Test: create/list/delete skill.

### Phase 9 — MITM proxy
- Local MITM server with cert generation for IDE cert pinning.
- dbReader for IDE credential stores.
- Dashboard: MITM status + cert install instructions.
- Test: MITM server starts/stops.

### Phase 10 — Workspaces + proxy pools + provider-nodes + observability
- Workspaces CRUD; proxy pools; provider-nodes; observability endpoint (`/api/observability`).
- Dashboard pages.
- Test: CRUD round-trips.

### Phase 11 — i18n
- Locale files + `/api/locale`; 10+ languages for dashboard + marketing site.
- Test: locale switching renders.

### Phase 12 — Docker + CI image + CLI-tools integration + pxpipe
- Dockerfile + docker-compose + GHCR publish workflow.
- CLI-tools integration hooks (Claude Code, Cursor, etc.).
- pxpipe endpoint.
- Test: docker build smoke (CI).

## Definition of done
Each phase: pnpm verify passes; committed, tagged, pushed, GitHub release. Scope is large; phases ship incrementally.

## Notes
- Provider/model counts are NOT in scope.
- Publishing to npm remains suspended; desktop app + build-from-source are supported install paths.
- Security invariants (browser-storage allowlist, no-secrets scan, gateway-routes spec sync) must hold for every new route.
