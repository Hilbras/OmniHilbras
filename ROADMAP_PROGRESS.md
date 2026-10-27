# OmniHilbras 12-Item Roadmap — Progress Report

**Date:** 2026-10-27  
**Branch:** `main`  
**Last Verified Build:** ✅ `npx next build` passes

---

## ✅ Completed Items (1–9, 12)

### Item 1 — Provider Refresh Button
- **Location:** Provider detail page connections card
- **Implementation:** Added "Refresh" button that re-fetches models and connection status
- **Verification:** UI interaction confirmed

### Item 2 — Usage Tab Real Data
- **Location:** `src/app/(dashboard)/dashboard/providers/[id]/ProviderUsageTab.js`
- **Implementation:** Reads from global usage store (`usageHistory` / `usageDaily`), filtered by provider
- **Special case:** `ollama-local` shows "Local instance — usage not tracked" instead of empty state

### Item 3 — Auto-Fetch Models on Connect
- **Mechanism:** Universal `modelsFetcher` config per provider + `useEffect` trigger on first successful connection
- **Coverage:** All providers with `modelsFetcher` in registry now auto-populate suggested models

### Item 4 — Model Test Caching + Progressive Results
- **Implementation:** Cached test status (`testStatus`, `lastTested`, `lastError`) per connection
- **UI:** Progressive reveal in provider page — shows counts on success, exact reason on failure

### Item 5 — Endpoint Page Redesign
- **Location:** `/dashboard/endpoint`
- **Changes:** Single-column layout, "Require login" toggle persisted in settings, cleaned up credential fields

### Item 6 — Push Phase 1 to GitHub & npm
- **Published:** `@hilbras/omnihilbras@2.9.9`
- **Tag:** `v2.9.9` on GitHub

### Item 7 — Web-Cookie Agent Tool Support
- **Executor:** `open-sse/executors/webcookie-agent.js` (`WebCookieAgentExecutor`)
- **Tools:** `AGENT_TOOLS` registry — `web_search`, `web_fetch`, `image_gen`, `tts`, `stt`, `embeddings`, `video_gen`
- **Loop:** `AGENT_MAX_TOOL_ROUNDS=6`, `AGENT_MAX_TOOL_CALLS_PER_TURN=8`, fail-open error handling
- **Target:** `webcookie-agent` (auto-picks active member) or `webcookie-agent/<provider>`

### Item 8 — Combo Auto-Switch (Strategy UI + Health-Aware Routing)
- **UI:** Per-combo strategy selector — `fallback`, `round-robin`, `fusion` (panel + judge)
- **Routing:** Health-aware — skips connections with recent errors, respects `comboStickyRoundRobinLimit`
- **Settings:** `comboStrategies` persisted in settings, rotation state reset on strategy change

### Item 9 — Ollama First-Class Support
- **Providers:** Two distinct entries
  - `ollama-local` — Category `apikey`, `serviceKinds: ["llm"]`, `baseUrl: http://localhost:11434/api/chat`, `modelsFetcher: { url: "http://localhost:11434/api/tags", type: "ollama-local" }`, executor `OllamaLocalExecutor` reads `providerSpecificData.baseUrl`
  - `ollama` (Cloud) — Category `freeTier`, `serviceKinds: ["llm", "webFetch"]`, `baseUrl: https://ollama.com/api/chat`, `modelsFetcher: { url: "https://ollama.com/api/tags", type: "openai" }`, includes `fetchConfig` for web fetch
- **Filter:** New `ollama-local` filter in `filters.js` parses `{ models: [{ model, name, ... }] }` response
- **Usage tab:** Early return for `ollama-local` → "Local instance — usage not tracked"
- **Icons:** `public/providers/ollama-local.png` + `ollama.png`
- **Build:** Clean pass

---

### Item 12 — Observability Stack
**Goal:** Full request-level observability: logs, metrics, retention, export.

**Status:** ✅ Done, committed on `feat/ollama-local-observability`.

**Storage:** `src/lib/db/repos/observabilityRepo.js` replaces `requestDetailsRepo.js` (deleted) and keeps the
existing `requestDetails` table. The planned rename to `observabilityLog` was dropped: it would have needed a
data-copy migration and broken the backup exclusion, legacy JSON import and existing tests for no gain — so no
migration 003 and no schema version bump. Legacy function names are kept as wrappers.

New repo functions: `getObservabilityStats(period)`, `deleteRequestLogsBefore(date)`,
`invalidateObservabilityConfig()`; `getObservabilityConfig` is now exported.

**API** (all behind dashboard auth via `dashboardGuard`; request/response bodies always redacted, same rule as
`/api/usage/request-details`):
| Route | Purpose |
|-------|---------|
| `GET/PATCH /api/observability/settings` | `enabled`, `maxRecords`, `batchSize`, `flushIntervalMs`, `maxJsonSize` (KB), validated ranges; reports `envOverride` |
| `GET /api/observability/logs` | Filters + pagination, plus provider/model/connection facets |
| `DELETE /api/observability/logs` | `{ ids }`, `{ before }` or `{ all: true }` |
| `GET/DELETE /api/observability/log/[id]` | Single entry |
| `POST /api/observability/export` | JSONL or CSV download, same filters |
| `GET /api/observability/stats?period=24h\|7d\|30d\|all` | Totals, req/min, tokens/min, error rate, avg latency, per-provider/model, retention |

Shared helpers: `src/lib/observability/logQuery.js` (redaction, filter parsing, CSV/JSONL).

**UI:** `/dashboard/observability` with Logs (filters, table, multi-select delete, clear all, export, entry drawer),
Metrics (stat tiles, per-provider/model bars, retention bar) and Settings tabs. Sidebar entry added; profile
Observability card links to the settings tab.

**Gateway integration:** already in place — `open-sse/handlers/chatCore*` call `saveRequestDetail`.

**Tests:** `tests/unit/observability-repo.test.js`.

**Not done:**
- Smoke-tested on an isolated dev server: auth (401 without credentials), settings validation, filters, facets,
  single entry, stats, CSV/JSONL export (no payload leak), every delete path, and all three tabs render.

**On/off precedence (decided):** the UI toggle decides; `OBSERVABILITY_ENABLED=false` is an operator kill switch
that forces recording off (the Settings tab says so and disables the toggle). `ENABLE_REQUEST_LOGS` no longer
affects the dashboard log — it only controls the file logs under `logs/`, as the README documents. Note: deployments
that set `ENABLE_REQUEST_LOGS=true` to get dashboard logs must turn the UI toggle on once.

---

## 📋 Planned Items (10–11) — Not Started

### Item 10 — Team Workspace Mode
**Goal:** Multi-workspace isolation so a single OmniHilbras install serves several teams/projects.

**Design:**
- **Data model:** New tables `workspaces` + `workspaceKeys`
- **DB isolation:** Workspace-keyed SQLite file per workspace (default `omnihilbras.db` = workspace "default")
- **Auth:** `apiKeys` extended with `workspaceId` scope; `accessAllow` carries allowed workspace IDs
- **API:** `GET/POST/PATCH/DELETE /api/workspaces`, `GET/POST /api/workspaces/[id]/keys`, `GET /api/workspace/current`
- **Data-layer filtering:** All repo reads add `WHERE workspaceId = ?` from auth context
- **UI:** Sidebar workspace picker, "Settings → Workspaces" page (CRUD, manage keys, import/export)

**Risk:** Global `getAdapter()` singleton must become workspace-aware.

---

### Item 11 — Skill Marketplace
**Goal:** Curated, installable skill store inside the dashboard.

**Design:**
- **Catalog source:** `SKILLS_INDEX.json` (manifest) + existing `skills/` folder as default local marketplace
- **Service layer:** `SkillStore` — `fetchManifest()`, `getSkillText(id)`, `installSkill(id)`, `uninstallSkill(id)`, `searchSkills(query)`
- **Persistence:** Installed skills as `~/.omnihilbras/skills/<id>/SKILL.md` + DB metadata row
- **API:** `GET /api/skills?q=`, `GET /api/skills/<id>`, `POST /api/skills/install`, `DELETE /api/skills/<id>`, `GET /api/skills/mine`
- **UI:** Two tabs — **Discover** (catalog + install button) + **My Skills** (installed, copy prompt, delete); search bar + category chips

---

## 🔧 Cross-Cutting Concerns

| Concern | Status |
|---------|--------|
| DB schema version bump | Pending (migration for Item 10; Item 12 needed none) |
| i18n literals (EN) | Pending for new UI strings (Item 12 page is EN-only) |
| Test snapshots (`tests/__baseline__`) | Need update if DB row shapes change |
| npm/GitHub release | Items 1–9 and 12 committed on a branch; Items 10–11 pending |

---

## 🚀 Next Actions (Priority Order)

1. **Merge `feat/ollama-local-observability`** (Items 9 + 12)
2. **Item 11 (Skill Marketplace)** — independent (~2 days)
3. **Item 10 (Team Workspace)** — depends on DB architecture changes, largest scope (~1 week)

---

## 📝 Notes for Maintainers

- The `observabilityRepo.js` intentionally keeps the legacy function names (`saveRequestDetail`, `getRequestDetails`, etc.) as thin wrappers so zero callers need updating.
- `requestDetailsDb.js` shim now points to observability exports — no breaking changes.
- The table is still named `requestDetails`; `backup.js` excludes it from pre-migration backups.
- Ollama Local executor uses `resolveOllamaLocalHost(credentials)` which falls back to `http://localhost:11434`; custom base URLs via `providerSpecificData.baseUrl` in connection.
- Combo auto-switch strategy is per-combo (stored in `settings.comboStrategies`), not global.