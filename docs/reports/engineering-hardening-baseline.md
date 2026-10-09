# Engineering hardening baseline

Recorded before any roadmap change. Uncommitted working-tree changes from the provider and usage work are present; they are listed in the last section.

## Baseline verification

`pnpm verify` (canonical: version check, brand, typecheck, test, build, bundle analysis) exits 0.

| Suite | Tests | Pass | Fail |
| --- | --- | --- | --- |
| Repo guards (`tests/*.test.js`) | 18 | 18 | 0 |
| Repo guards (second stage) | 160 | 160 | 0 |
| SDK (`packages/omnihilbras-sdk`) | 551 | 551 | 0 |
| Gateway (`apps/gateway`) | 570 | 570 | 0 |

Source: `/tmp/baseline-verify.log`, run on branch `main`, HEAD `fbcff88`.

## Verified findings

### F1 — Dashboard trust is derived from a request header (security, known)

`apps/gateway/src/server.ts:81` sets `kind: 'dashboard'` when the request `Origin` is in the allowlist. `isTrustedDashboard` (`runtime.ts:102`) returns true for that kind. The management gate (`server.ts:249`) then skips API-key authorization for any request that is trusted this way.

`Origin` is a browser-set header. A local non-browser process can send it freely. The project records this as an honest limitation in `server.ts:165–170`, and names the fix: a per-launch secret the browser presents. This is a design change, not a patch.

Roadmap mapping: Phase 1.2. Status: **verified, not fixed**.

### F2 — The OAuth callback exemption is narrow (no defect found)

`isOauthCallbackNavigation` (`http.ts:77`) exempts only `GET` requests to two constant callback paths. The path check uses gateway constants, not request values. Roadmap mapping: Phase 1.4. Status: **verified correct for the callback paths; replay and session-expiry tests not yet audited**.

### F3 — CI runs a divergent subset of `pnpm verify` (CI integrity)

`.github/workflows/verify.yml` runs `version:check`, `typecheck`, `test` and `build` as separate steps. It does not run `test:brand` or `analyze:check`, which the canonical `verify` script includes. So CI can pass where `pnpm verify` would fail.

Roadmap mapping: Phase 2.1. Status: **verified divergence, not fixed**.

## Classification of roadmap items

| Item | Status |
| --- | --- |
| 1.2 Dashboard authorization | partial: F1 is a known, documented gap |
| 1.3 API-key lifecycle | requires verification |
| 1.4 OAuth callback security | partial: path narrowing verified; replay tests missing |
| 1.5 SSRF and custom endpoints | requires verification |
| 1.6 Secure storage | requires verification |
| 2.1 Unified verification in CI | missing: F3 |
| 2.3 Published SDK artifact validation | missing |
| 3.x Provider fixtures | partial: fixture tests exist per adapter; no inventory report |
| 4.x Request execution and rate limits | requires verification |
| 5.x Streaming reliability | requires verification |
| 6.x Provider lifecycle isolation | partial: provider-specific logic lives in the service |
| 7.x Observability and usage | partial: usage store exists; attempt-level correlation missing |
| 8.x Frontend quality | partial |
| 9.x Benchmarks | missing |
| 10.x Documentation source of truth | partial |

## Uncommitted changes present at baseline

Provider and usage work not yet committed: Console workspace picker (gateway), model `qualifiedId` and provider-prefix routing, APInex card, Zen fingerprint tools, and the usage paging and diagram changes. Their tests pass, but they are not in the baseline commit.

## Recommended order

1. F3 first: make CI run the canonical `pnpm verify`, since it is cheapest and blocks every later change from being verified properly.
2. F1: design the per-launch secret. This needs a decision before code.
3. Replay, expiry and SSRF audits (1.4, 1.5), each with negative tests.
