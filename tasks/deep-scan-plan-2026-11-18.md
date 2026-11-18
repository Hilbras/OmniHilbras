# Implementation plan — deep-scan remediation (2026-11-18)

## Overview

Work from the four-area scan (`tasks/deep-scan-2026-11-18.md`) in dependency order: finish and
prove the uncommitted `3.67.0` tool contract, fix the dashboard controls that report unmeasured
results, close the gateway guard blind spots, then reconcile docs/process and record the decisions
that require a human. The goal and its success criteria are in
`tasks/deep-scan-goal-2026-11-18.md`.

**Waiting for your order.** Nothing below has been implemented. No source file was changed by the
scan. Do not start a task until you say so.

## Architecture / dependency order

```
Kernel/Tools (caps + normalize + args + stream)
    ├── Kernel/API service.ts (applyToolContract, validatedToolResponse)
    │       └── routes/inference.ts (gateway.tools on chat / responses / models)
    │             └── dashboard client + e2e stubs
    └── root guards (tools-caps, tools-behaviour) + docs/SPEC-SDK.md
                    │
                    ▼
        dashboard truthfulness fixes (independent of gateway internals)
                    │
                    ▼
        route/documentation guards + CI + release docs
                    │
                    ▼
        security-limit decisions + historical open items (human input)
```

Rules that determine order:

- A capability row is not "done" until an adapter's **wire body** is asserted; that test work
  belongs in the same phase as the row.
- Docs are corrected **after** the behavior they describe, so they do not need a second rewrite.
- A behaviour-changing phase is released before the next phase starts (`AGENTS.md` standing rule).
  Suggested sequence: `3.67.0` (Phase 0) → `3.67.1` (Phase 1) → `3.67.2` (Phase 2) → `3.67.3`
  (Phase 3, and Phase 4 if docs only). A genuinely new capability from Phase 4 means `3.68.0`.

---

## Phase 0 — Prove and land the `3.67.0` tool contract

Findings F01–F12, F29 (SPEC status line). Highest risk: the phase claims more than its guards prove.

- [x] **T01 — Correct the forced-refusal status and assert it on the wire** (F01, XS)
  - Acceptance: `docs/SPEC-SDK.md:864` says `501 NOT_SUPPORTED`; a test asserts both the status and
    the code for a forced call on a provider that cannot force.
  - Verify: `node --test Kernel/API/test/tool-contract.test.js`, then `pnpm verify`.
  - Deps: none. Files: `docs/SPEC-SDK.md`, `Kernel/API/test/tool-contract.test.js`.

- [x] **T02 — Derive declared tool names after normalization** (F02, S)
  - Acceptance: `declared` comes from the normalized request; a returned call naming a definition
    that was dropped (web provider, refused wire, invalid/oversized definition) is not forwarded
    and does not claim `finish_reason: tool_calls`.
  - Verify: new case in `Kernel/API/test/tool-contract.test.js`; revert-check by restoring the
    pre-normalization `map`, which must fail the new case.
  - Deps: none. Files: `Kernel/API/src/core/service.ts`, `Kernel/API/test/tool-contract.test.js`.

- [x] **T03 — Name the serving provider in the streaming tool note** (F03, S)
  - Acceptance: uses the successful attempt (`find(a => a.ok)`), not the first attempt; a failover
    from a tools-capable to a tools-less provider (and the reverse) emits the correct note, and a
    turn with no attempts yet emits no false note.
  - Verify: new failover case in `Kernel/API/test/tool-surface.test.js`; revert-check.
  - Deps: none. Files: `Kernel/API/src/routes/inference.ts`, `Kernel/API/test/tool-surface.test.js`.

- [x] **T04 — Make the behavioural caps guard non-tautological** (F04, M)
  - Acceptance: every row claiming `required` is driven through a scripted transport and the
    adapter's emitted body is asserted — including `codebuddy-cn/-intl`, `kilocode`,
    `minimax-code/-global`, `zcode`, `opencode` and `opencode-go`. The guard fails if a row claims
    forcing that its adapter does not send. The existing anthropic/gemini/openai/codex cases stay.
  - Verify: `node --test tests/tools-behaviour.test.js`; flip one caps row to `required` and
    confirm the guard fails.
  - Deps: T08 (OpenCode free-tier decision) for those two rows. Files:
    `tests/tools-behaviour.test.js`, possibly adapter-specific fixtures under `Kernel/SDK/tests/`.

- [x] **T05 — Unit-test `guardToolStream` and fix cross-chunk finish reason** (F05, M)
  - Acceptance: direct tests cover non-object deltas, zero-delta chunks, cross-chunk name
    resolution, `report.allowed`, mixed allowed+blocked calls arriving in different chunks, and
    `finishReason` remaining `tool_calls` when an allowed call was emitted earlier. The
    "all blocked in this chunk" rewrite only applies when no allowed call was emitted at all.
  - Verify: `pnpm test:tools` (after `pnpm build:tools`) and `pnpm test`.
  - Deps: none. Files: `Kernel/Tools/src/stream.ts`, `Kernel/Tools/test/tools.test.js`.

- [x] **T06 — Cover `gateway.tools` on `/v1/responses`** (F06, XS)
  - Acceptance: both non-stream and streamed `response.completed` responses carry/omit the note
    per the provider's caps, asserted over HTTP.
  - Verify: `node --test Kernel/API/test/tool-surface.test.js`.
  - Deps: T03. Files: `Kernel/API/test/tool-surface.test.js`.

- [x] **T07 — Refuse a forced choice with no definitions** (F07, S)
  - Acceptance: `required`/`none` with no `tools` is normalized deterministically (refused by name
    or dropped with a reason), never sent as a bare `toolConfig`/`tool_choice` that a provider may
    reject; Gemini's mapping is guarded by the presence of tools.
  - Verify: new cases in `Kernel/Tools/test/tools.test.js` and `tests/tools-behaviour.test.js`.
  - Deps: none. Files: `Kernel/Tools/src/normalize.ts`, `Kernel/SDK/gemini/adapter/index.ts`, tests.

- [x] **T08 — Resolve the OpenCode forced-call claim** (F08, M)
  - Acceptance: either the gated/free-tier path sends the forced mapping, or the caps row and
    `SPEC-SDK.md:852` explicitly scope forcing to paid models and `tool_choice: required` on a
    gated model is refused by name. No silent downgrade.
  - Verify: a gated-model case in `tests/tools-behaviour.test.js`; `pnpm test:repo`.
  - Deps: none. Files: `Kernel/Tools/src/caps.ts`, `Kernel/SDK/opencode-{go,zen,console}/lib/zen-free-tier.ts`,
    `docs/SPEC-SDK.md`, tests.

- [x] **T09 — Verify Tools is present in the packaged desktop app** (F09, S)
  - Acceptance: `pnpm app:check` passes and the packaged gateway resolves `@omnihilbras/tools`
    from the asar; either electron-builder's symlink handling is confirmed or
    `package.json build.files` gains an explicit `Kernel/Tools/dist/**` entry.
  - Verify: `pnpm app:check`, `pnpm app:size`.
  - Deps: T01–T08 (so the packaged code is final). Files: `package.json` if needed.

- [x] **T10 — Make the caps guard compare against the gateway's provider set** (F10, M)
  - Acceptance: the guard checks both the catalogue cards **and** the ids registered in
    `Kernel/API/src/core/service.ts`; `caps.ts`'s comment describes what it really checks.
  - Verify: `node --test tests/tools-caps.test.js`; add a temporary fake catalog id and confirm
    failure.
  - Deps: T04. Files: `Kernel/Tools/src/caps.ts`, `tests/tools-caps.test.js`.

- [x] **T11 — Guard vendored Cline twin drift** (F11, S)
  - Acceptance: a test diffs the shared implementation of `cline/adapter/index.ts` and
    `clinepass/lib/cline.ts` after normalizing the known intentional differences (import paths,
    version constant, comments); a change to one copy alone fails.
  - Verify: `pnpm test:repo`; edit a harmless comment in one copy and confirm failure.
  - Deps: none. Files: new `tests/cline-twin-drift.test.js`.

- [x] **T12 — Remove the tool-phase dead code and stale comments** (F12, XS)
  - Acceptance: the no-op spread in `normalize.ts:98` is gone; `clean-sdk-dist.mjs`'s module doc
    lists Tools; `caps.ts`'s guard comment matches T10.
  - Verify: `pnpm verify`. Deps: T10. Files: as listed.

### Checkpoint 0 — release `3.67.0`

- [x] `pnpm verify` passes; every new guard revert-checked.
- [x] `docs/SPEC-SDK.md` and `README.md` describe the final tool contract.
- [ ] Commit, tag `v3.67.0`, push to `origin/main`, GitHub release with verification notes;
      `npm publish --access public` from `cli/`; `npm view @hilbras/omnihilbras@3.67.0 version`
      echoes `3.67.0`; `pnpm release:audit` shows no new gap.
- [ ] Human review before Phase 1.

---

## Phase 1 — Dashboard truthfulness

Findings F17–F24. Each fix follows the pattern already used in `ApiKeysPage`: measure, label the
unknown, clean up timers, guard the response shape.

- [x] **T13 — Settings "Test connection" reports what happened** (F17, S)
  - Acceptance: `loadGateway` returns a result instead of swallowing the failure; the button
    flashes OK only on a real answer and the real error otherwise; no unreachable catch remains.
  - Verify: new runtime test in `tests/dashboard-wiring.test.js` that drives the handler with a
    failing client; `pnpm test:repo`.
  - Deps: none. Files: `src/pages/SettingsPage.tsx`, `tests/dashboard-wiring.test.js`.

- [x] **T14 — Settings enforcement switch shows "unknown" before the answer** (F18, S)
  - Acceptance: `requireApiKey` uses `boolean | null` (or equivalent), renders a disabled
    "unknown" state until the gateway answers, and cannot be flipped while unknown — matching
    `ApiKeysPage.tsx:133-137`.
  - Verify: new guard in `tests/api-keys-page.test.js` or `tests/dashboard-wiring.test.js`;
    revert-check `?? true`.
  - Deps: none. Files: `src/pages/SettingsPage.tsx`, tests.

- [x] **T15 — ProvidersPage notice timers cannot clear each other** (F19, M)
  - Acceptance: a single `noticeTimer` ref with cleanup on change/unmount replaces all seven bare
    timers; `handleSaveMany`'s summary survives `handleSave`'s timer; a notice set after unmount
    produces no state update.
  - Verify: new runtime test (jsdom or e2e) that fires two notices in sequence and asserts the
    second stays visible past the first timer; `pnpm test:e2e` for the keys/providers routes.
  - Deps: none. Files: `src/pages/ProvidersPage.tsx`, `tests/dashboard-wiring.test.js`,
    `tests/e2e/buttons.spec.ts`.

- [x] **T16 — Token Saver page tolerates a partial stats response** (F20, S)
  - Acceptance: `cache`, `savers` and `byProvider` are checked/normalized before rendering; a
    response missing any of them shows an honest "no data" state instead of blanking the page.
  - Verify: new e2e stub case for `/dashboard/token-saver`; `pnpm test:e2e`.
  - Deps: none. Files: `src/pages/TokenSaverPage.tsx`, `tests/e2e/smoke.spec.ts`.

- [x] **T17 — Classify `.webp` provider marks** (F21, M)
  - Acceptance: the polarity plugin and `tests/dashboard-assets.test.js` include `.webp`; the two
    webp marks appear in `logoPolarity.generated.ts` with a measured background; missing/low-
    confidence assets are reported, not silently defaulted.
  - Verify: `pnpm test:brand`, `node --test tests/dashboard-assets.test.js`, `pnpm build`.
  - Deps: none. Files: `vite.config.ts`, `tests/dashboard-assets.test.js`, generated file.

- [x] **T18 — Remove the stale e2e toast exemption** (F22, S)
  - Acceptance: `KNOWN_DEFECTS` no longer excludes "Dismiss notification"; the button is pressed
    on the route where it appears and produces a real DOM change; no console error.
  - Verify: `npx playwright test tests/e2e/buttons.spec.ts`; revert-check by reintroducing the
    malformed toast entry.
  - Deps: T15 (so the notice path is sound). Files: `tests/e2e/buttons.spec.ts`.

- [x] **T19 — Route constants and docs cover every served route** (F23, M)
  - Acceptance: `/about` and `/token-saver` are constants in `src/lib/routes.ts` used by the
    router; `tests/documentation-counts.test.js` is made **bidirectional** (served ⇒ documented,
    documented ⇒ served); README's `/dashboard` description is single and matches the code.
  - Verify: `node --test tests/documentation-counts.test.js`, `pnpm test:repo`; delete a route
    constant and confirm the guard fails.
  - Deps: none. Files: `src/lib/routes.ts`, `src/dashboardApp.tsx`, README,
    `tests/documentation-counts.test.js`.

- [x] **T20 — Bring the Models dialog to the shared a11y bar** (F24, M)
  - Acceptance: Escape closes, focus is trapped and restored; close control is `aria-hidden`;
    `tests/accessibility.test.js` gains checks for those behaviours (not just the attribute).
  - Verify: `node --test tests/accessibility.test.js` and `npx playwright test tests/e2e/smoke.spec.ts`.
  - Deps: none. Files: `src/pages/ModelsPage.tsx`, `tests/accessibility.test.js`.

### Checkpoint 1 — release `3.67.1`

- [x] `pnpm verify` and `pnpm test:e2e` pass on a clean build.
- [x] Each fix revert-checked; browser run recorded for T15/T18/T20.
- [ ] Commit, tag, push, release, publish `cli@3.67.1`, confirm with `npm view`, audit trail clean.

---

## Phase 2 — Gateway guard blind spots and test depth

Findings F13–F16, F28.

- [x] **T21 — Route guard sees regex-dispatched routes and registration** (F13, M)
  - Acceptance: the three regex paths are expressed as named constants or a helper the guard
    understands; the guard reads `server.ts`'s registration list and fails if a handler file is
    never registered (the follow-up from `tasks/todo.md:6164`); all three routes remain documented.
  - Verify: `node --test tests/gateway-routes.test.js`; remove a registration and confirm failure.
  - Deps: none. Files: `tests/gateway-routes.test.js`, `Kernel/API/src/routes/{status,oauth,connections}.ts`,
    `Kernel/API/src/server.ts`.

- [x] **T22 — Fill thin tests on credential-adjacent routes** (F15, M)
  - Acceptance: `/v1/mcp`, `/v1/skills`, log stream, `/v1/system`, private destinations each have
    tests for their success shape, refusal shape and unauthenticated/management-gated behaviour;
    no live provider request is made.
  - Verify: `pnpm test:gateway`.
  - Deps: T21 (route constants). Files: selected files in `Kernel/API/test/`.

- [x] **T23 — Close the e2e route and baseline gaps** (F28, M)
  - Acceptance: smoke and button sweeps include `/dashboard/` and `/dashboard/token-saver`;
    the two `test.fixme` visual baselines are either re-baselined stably or recorded as a stated
    decision with measured pixel counts; `opencode-runtime.spec.ts` stubs the gateway or skips
    with an explicit reason when no gateway is present; no silent skip.
  - Verify: two consecutive `pnpm test:e2e` runs green.
  - Deps: T16, T18. Files: `tests/e2e/{smoke,buttons,visual,opencode-runtime}.spec.ts`.

- [x] **T24 — Remove dead UI code and stale comments** (F25, M)
  - Acceptance: unreachable query-param provider page and its `DashboardShell` import are gone;
    the stale Fast Refresh / "Request log" comments are corrected; duplicate `.glass` CSS is
    removed (or used and then measured — no blur behind scrolled content).
  - Verify: `pnpm typecheck`, `pnpm test:repo` (`tests/ui-performance.test.js` included).
  - Deps: none. Files: `src/pages/ProviderDetailPage.tsx`, `vite.config.ts`,
    `src/components/DashboardShell.tsx`, `src/dashboardApp.tsx`, `src/index.css`.

- [x] **T25 — Tokenize hard-coded accent colours and live port hints** (F26, F27, M, low priority)
  - Acceptance: palette hex values in the listed files use existing tokens (deliberate terminal
    accents are documented rather than left anonymous); user-facing port hints read the configured
    port instead of literal `20138`; duplicate icon resolved.
  - Verify: `pnpm test:brand`, `pnpm verify`. Deps: T24. Files: ~13 UI files as listed in F26/F27.

### Checkpoint 2 — release `3.67.2`

- [x] `pnpm verify`, `pnpm test:e2e`, `pnpm app:check` pass.
- [ ] Commit, tag, push, release, publish, confirm, audit.
- [ ] Human review before the docs/process phase.

---

## Phase 3 — Docs, process and release hygiene

Findings F29–F32.

- [x] **T26 — Documentation truth pass** (F29, M)
  - Acceptance: SPEC status reflects the current release; CONTRIBUTING agrees that `cli/` is
    published; README's "routing guards are red" and `/dashboard` lines are gone or corrected;
    `scripts/check-version.mjs` comment matches the real publish state; workflow prose counts are
    replaced by a reference to the gate. All statements are checked against the code, not guessed.
  - Verify: `pnpm version:check`, `pnpm verify`, `node --test tests/documentation-counts.test.js`.
  - Deps: Phases 0–2 released (so docs describe final code). Files: as listed in F29.

- [x] **T27 — Reconcile task-bookkeeping state** (F30, XS)
  - Acceptance: the 31 + 26 stale unchecked boxes in the two completed desktop plans are either
    ticked with a pointer to the Result section or explicitly annotated as historical; a new index
    in `tasks/README.md` (or the scan doc) points to this plan and its goal; `tasks/todo.md` and
    `tasks/plan.md` are left untouched.
  - Verify: `grep -c '^\s*- \[ \]' tasks/*.md` shows no unexplained open boxes.
  - Deps: none. Files: `tasks/desktop-hardening-plan.md`, `tasks/app-conversion.md`, new index.

- [x] **T28 — De-fragile release and analysis scripts** (F31, M)
  - Acceptance: `release:audit` no longer depends on a 400-release GitHub limit or a growing
    exemption list for its correctness (paging or a local tag set); bundle analysis names pages
    from a stable source, not a filename split; `clean-sdk-dist`'s doc lists every cleaned path.
  - Verify: `pnpm release:audit`, `pnpm analyze:check`, `node --test tests/release-trail.test.js`.
  - Deps: none. Files: `scripts/{audit-release-trail,analyze-bundle,clean-sdk-dist}.mjs`.

- [x] **T29 — CI covers the new contract and protects tags** (F32, M)
  - Acceptance: a workflow runs the tool tests directly (or a comment anywhere proves the single
    `verify` gate covers them on every push); `docker.yml` refuses tags not on `main` before any
    push, matching `desktop.yml`; workflow prose counts removed.
  - Verify: inspect workflow YAML and `gh run list` after the next push; no secret is exposed to
    untrusted code.
  - Deps: T26. Files: `.github/workflows/{verify,e2e,desktop,docker,release-audit}.yml`.

### Checkpoint 3 — release `3.67.3`

- [ ] Docs-only unless T28/T29 change behavior; bump accordingly per `AGENTS.md`.
- [ ] `pnpm verify`, `pnpm release:audit`, `gh run list` green; commit/tag/release/publish.

---

## Phase 4 — Deferred items and human decisions

Findings F14, F33. **No implementation starts here without your explicit choice.**

- [x] **T30 — Security limitation disposition** (F14, M)
  - Acceptance: each of DNS rebinding, `Origin`-based dashboard trust, unauthenticated OAuth
    callback carve-outs, OpenCode `all` mode and the recorded SHA is marked **accepted with reason**
    or **scheduled as a fix** in `SECURITY.md`/`SPEC-SDK.md`, with the trade-off written down.
  - Verify: `pnpm test:repo` (security guards unchanged unless a fix is approved), doc review.
  - Deps: Phase 3. Files: `SECURITY.md`, `docs/SPEC-SDK.md`, possibly gateway security code.

- [x] **T31 — Re-verify historical open items** (F33, M)
  - Acceptance: each item is checked against current code; closed ones get a one-line "resolved
    in <version>" in the scan doc; still-open ones get an owner/decision. Kiro tool calls and the
    3.59 hedging-sibling report are confirmed already resolved and are **not** reopened.
  - Verify: code reading plus focused tests; no live provider call unless separately approved.
  - Deps: none. Files: `tasks/deep-scan-2026-11-18.md`, docs for any newly confirmed gap.

- [x] **T32 — Decide the two architecture seams** (F33, M)
  - Acceptance: a recorded decision on `CredentialProvisioner` (`docs/architecture/README.md:147`)
    and the adapter harness seam (`:344`) — implement now, schedule separately, or decline with
    reason. If either is approved, it becomes a new `3.68.0` phase with its own plan.
  - Verify: ADR or architecture doc entry; `pnpm verify` if code changes.
  - Deps: T31. Files: `docs/architecture/README.md`, possibly a new ADR.

- [!] **T33 — ZCode usage measurement recheck** (F33, S, external)
  - Acceptance: once quota resets, one real streamed turn is inspected for `message_delta.usage`;
    the result is recorded as measured or as still unknown. No guessed conclusion.
  - Verify: captured response in `docs/SPEC-SDK.md` or the scan doc. Requires your credential/OK.
  - Deps: human decision. Files: docs only.

### Final checkpoint

- [ ] Every goal success criterion in `tasks/deep-scan-goal-2026-11-18.md` is checked.
- [ ] `pnpm verify`, `pnpm test:e2e`, `pnpm app:check`, `pnpm release:audit` all pass.
- [ ] Final commit/tag/release/publish per phase; no new release-trail gap.

---

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| The 3.67.0 work is uncommitted and CI has never seen it | High — a red gate after release | Finish Phase 0 tests first; `pnpm verify` from a clean checkout before tagging. |
| Fixing a guard while trusting its old claim (F04) | High — false confidence | Drive real adapter wires; flip a caps row and confirm the guard fails. |
| "Test connection"/switch/timer fixes change user-visible behavior | Medium | Runtime tests plus browser run; revert-check each. |
| Regex route refactor changes dispatch order | High — route stops working | Keep registration order in `server.ts`; add a handler-level test per refactored route. |
| Docs rewritten before behavior settles | Low — second rewrite | Docs phase runs last. |
| Live provider probes cost money or need credentials | Medium | No live calls without your order; prefer scripted transports and stubs. |
| Release-per-phase adds overhead | Medium | Follow `AGENTS.md`; use the single `pnpm verify` gate and `release:audit` to keep it mechanical. |
| Static guards cannot prove behavior (browser audit's main caveat) | Medium | Add runtime cases for every new truthfulness fix; keep static guards where they still catch regressions. |

## Open questions — need your answer before the corresponding task

1. **Security disposition (T30):** accept the documented limitations as-is, or fund fixes for DNS
   rebinding and `Origin`-based trust? The latter is a design change, not a small fix.
2. **Architecture seams (T32):** implement `CredentialProvisioner` / the adapter harness in this
   plan, or record them as a separate `3.68.0` effort?
3. **Release cadence:** confirm one tag/release/publish per phase as above, or one combined release
   at the end.
4. **Live checks (T33):** do you have the ZCode credential and the OK to spend one streamed turn
   when quota resets?
5. **Accent colours (T25):** tokenize everything, or keep the terminal/code-window palette as a
   documented deliberate exception?
6. **Stale checkboxes (T27):** tick them as historical, or add a dated "superseded" banner to the
   two plans?

## Definition of done for every task

1. `pnpm verify` passes (version, brand, typecheck, tests, SPEC guard, build, bundle budget).
2. Relevant docs (`README.md`, `docs/SPEC-SDK.md`, `docs/architecture/`, `tasks/`) reflect the change.
3. Version bumped per `AGENTS.md`; `pnpm version:check` passes; derived copies rewritten with
   `pnpm version:fix`.
4. Commit, tag `v<version>` on `main`, push, GitHub release, `npm publish --access public` from
   `cli/`, confirmed with `npm view @hilbras/omnihilbras@<version> version`, and `pnpm release:audit`.
5. A revert check exists: removing the fix fails the new test.
