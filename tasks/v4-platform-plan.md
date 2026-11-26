# V4 platform plan

**Goal:** [v4-goal.md](./v4-goal.md) · **Baseline:** `3.100.2` (2026-11-25) · **Status:** 4.0.0 final: A/B/C/D complete; E shell palette and existing event/analytics surfaces; F route contracts, job history and existing packaging. Known limits are in docs/MIGRATION-4.0.md

## Why 4.0

The stack is not the problem. React 19/Vite, Node 24, Electron and the zero-dependency CLI are healthy. The measured ceilings are:

| Ceiling | Baseline |
| --- | --- |
| Vendored provider machinery | 57 SDK packages, **245 tracked TypeScript files** under `Kernel/SDK/*/lib/`, 56 copies each of `types.ts` and `errors.ts`, 25 `index.ts` copies |
| State | **11 JSON-file stores** in `Kernel/API/src/core`; only usage has an optional SQLite backend (`OMNIHILBRAS_USAGE_STORE=sqlite`) |
| Identity | single-operator: one admin key can read and change the vault; `workspaceId` is metadata, not authorization |
| HTTP surface | 31 route modules, hand-written validation, no generated contract |
| Dashboard | 17 pages, 19.6k lines, ~137 KB gzip initial JS, polling fallback beside `/v1/events` |
| Desktop | 225 MB unpacked build |

Already delivered and not to be re-invented: `/v1/events` SSE, SSE logs, `SqliteUsageStore`, virtual models/combos, quota tiers, token saver, provider catalog guards, per-port dashboard tokens, durable video idempotency, interprocess vault lock.

## Principles

1. **Local-first default; no phone-home.** Remote access is explicit and scoped.
2. **JSON stays a fallback.** SQLite is the default backend only if it can still fall back; the CLI bundle stays self-contained.
3. **Inference compatibility.** `/v1/chat/completions`, `/v1/responses`, `/v1/messages` and provider-prefixed ids keep working. Management surfaces may move to `/v2` with a deprecation window.
4. **Asserted, not promised.** Every behavior change ships with a failing-if-regressed test; every route gets a spec line and gateway test.
5. **Migrate, never strand.** Existing vaults, backups and keys upgrade automatically, with an encrypted pre-migration backup and a tested rollback.
6. **One source of truth per fact.** Shared adapter machinery, provider descriptions, capability rows and route contracts are derived, not copied.

## Phases

Each phase ships as a prerelease with the normal ceremony (`verify` → version → tag → push → GitHub release → npm → audit).

### Phase A — Shared provider core (`4.0.0-alpha.1`, `alpha.2`) — done

**Why first:** it is the highest maintenance leverage and the least user-visible risk. Every later provider/lifecycle change gets cheaper.

- Create `Kernel/SDK/_shared`, a private workspace package exporting the canonical `errors`, `url`, `streaming`, `bounded-map`, `model-normalize`, `transport`, `types`, `openai-compatible` and `responses-lane` modules.
- `types.ts` becomes one **superset**: every field any adapter currently declares (including `maxThinkingTokens`, `cacheAnchor`, `upstreamModelId`, `kiroAuthMethod`, `region`) with the same names and optionality. Importers compile unchanged.
- `transport.ts` and `openai-compatible.ts` variants are reconciled into one module; behavior differences are options, not forks.
- Provider-specific modules (`cline.ts`, `zen-adapter.ts`, `zen-free-tier.ts`, `pricing.ts`, `identity.ts`, `deepseek-pow.ts`, `startPlanTemplate.ts`, `constants.ts`, `encoding.ts`, `responses-tools.ts`) move into the owning package's `adapter/` or stay package-local until Phase D's manifest work.
- Every SDK package depends on `@omnihilbras/sdk-shared` and imports from it. No `lib/` shared copy remains.
- Replace `tests/vendored-lib-drift.test.js` with a guard that fails if a shared module reappears under any `Kernel/SDK/*/lib/`, and that vendors are gone from `git ls-files`.
- Update `AGENTS.md`, `docs/architecture/README.md`, `docs/SPEC-SDK.md` and the build/clean scripts.

**Exit criteria:** all 985 SDK tests and 1278 gateway tests pass; `pnpm build` and the CLI bundle succeed; `git ls-files 'Kernel/SDK/*/lib/*'` is empty or only provider-specific files; the drift guard fails on a planted copy.

### Phase B — State engine (`4.0.0-alpha.3`) — seam done; default flip pending

- Introduce `Kernel/API/src/core/state/` with a SQLite driver built on `node:sqlite` (WAL, prepared statements, busy timeout), a migration runner and a JSON fallback adapter.
- Move every store behind the same interface contract: connections/credentials, usage, API keys, workspaces, virtual models, tunnels, MITM, proxy pools, provider nodes, skills, request details.
- Add an append-only event journal used by `/v1/events` and audit; support `Last-Event-ID` replay and dashboard catch-up.
- Migrate existing JSON automatically after writing an encrypted backup; keep a read-only JSON export.
- Add a shared contract suite that runs every store against both backends.

**Exit criteria:** every store passes the contract suite on SQLite and JSON; upgrade/rollback tests pass; a killed process loses no committed write; `/v1/events` replays missed events.

### Phase C — Identity and policy (`4.0.0-alpha.4`, `alpha.5`) — done

- Add principals, roles (`owner`, `operator`, `viewer`) and scoped API keys. Scopes: `inference`, `manage`, `vault`, `read`.
- Enforce workspace isolation on every route; `workspaceId` becomes an authorization claim.
- Per-principal rate limits, spend budgets, model/provider allow-lists and audit records.
- Migrate existing admin keys to an `owner` principal; keep inference bearer compatibility.
- Add `/v2` management routes where the request/response shape must change; deprecate the old shape with warnings for one minor cycle.

**Exit criteria:** a viewer key cannot read the vault; a workspace cannot see another workspace; every mutation is audited; old keys keep working; route guards cover all management prefixes.

### Phase D — Provider lifecycle and manifests (`4.0.0-alpha.6`, `alpha.8`) — done

- `CredentialProvisioner` (`create` / `refresh` / `revoke` / `describe`) absorbs the hand-wired lifecycle branches.
- A unified adapter contract harness covering transport, fetch and driver doubles; every provider is in the matrix.
- Self-registering provider manifests: id, name, auth modes, capabilities, catalog metadata, routes. Dashboard cards, capability rows and OAuth route checks derive from them.
- Generate the provider compatibility matrix and the SPEC inventory from code.

**Exit criteria:** adding a provider is an adapter + manifest with no Core edit; all providers pass the harness; the manifest is the only place a provider is described.

### Phase E — V4 experience (`4.0.0-alpha.7`) — command palette done; wider shell/analytics pending

- App shell with grouped navigation (Operate / Observe / Configure), command palette, global search and status bar.
- Event-driven pages; polling only as fallback. No page needs a 4-second timer to feel current.
- Provider onboarding, account-centric provider pages, unified models/combos, cost and budget analytics with forecasts.
- V4 design system: tokens, density, empty/error/loading states, keyboard navigation, WCAG AA, visual regression baselines.
- Hold or lower the bundle budget while adding the shell; keep heavy charts lazy.

**Exit criteria:** axe critical 0, keyboard paths complete, visual baselines stable, initial JS budget met, live changes appear without polling.

### Phase F — Runtime, contracts and packaging (`4.0.0-alpha.9`, `alpha.10`) — contracts and jobs done; packaging already shipped in 3.99; done

- Typed route registry with zod schemas, request validation and generated OpenAPI.
- Graceful drain, liveness/readiness split, structured logs with trace ids, optional OpenTelemetry export.
- Durable background jobs for health sweeps, catalog refresh, video polling and backups.
- CLI: profiles, completions, `--json` everywhere, config-as-code, remote gateway via scoped keys, deeper `doctor`.
- Desktop: stable/beta channels, rollback, tray actions; measure and reduce the 225 MB unpacked build.
- Docker: multi-arch, non-root, healthcheck retained.

**Exit criteria:** OpenAPI matches served routes; drain loses no in-flight request; jobs survive restart; CLI/desktop e2e passes; package size target measured.

### `4.0.0` final

- Freeze, migration rehearsal from 3.100.2 and 3.99.x, upgrade guide, deprecation notes.
- Full `verify`, e2e, visual, load, security and release audit.
- Tag, GitHub release, npm `latest`, website release notes.

## Test gates

Every phase adds tests before the behavior:

- **Provider:** golden fixtures, contract harness, SSE multi-part streams, tool calls, capability matrix.
- **State:** backend contract suite, migration round-trip, crash/kill, backup restore, journal replay.
- **Identity:** scope matrix, workspace isolation, audit completeness, key migration.
- **HTTP:** route schema tests, OpenAPI drift, error envelope, drain.
- **UI:** axe, keyboard, visual baselines, bundle budget, real-time/no-poll assertions.
- **Packaging:** CLI smoke, desktop smoke, Docker health, install/upgrade paths.

## Risks and controls

| Risk | Control |
| --- | --- |
| Vault migration loses data | encrypted pre-migration backup, dry-run, rollback test on every store |
| Scoped keys break existing clients | old admin key maps to owner; `/v1` inference unchanged; `/v2` only where shape must change |
| Shared types break an adapter subtly | canonical superset, all 985 SDK tests, adapter harness, migrate in waves |
| UI rewrite regresses performance/a11y | measure before/after, budgets, axe and visual gates |
| Prerelease churn confuses users | `next` dist-tag; only `4.0.0` goes to `latest`; upgrade guide |

## Non-goals

- No framework rewrite, no mandatory database, no cloud multi-tenant claim, no big-bang adapter migration, no UI-only major.