# Execution log — deep-scan plan 2026-11-18

Plan: `tasks/deep-scan-plan-2026-11-18.md` · Goal: `tasks/deep-scan-goal-2026-11-18.md` · Evidence: `tasks/deep-scan-2026-11-18.md`

Status legend: `[ ]` pending · `[~]` in progress · `[x]` done and verified · `[!]` blocked / needs a decision.

Defaults chosen at start (no answers were given for the six open questions):
- Security limits → accept with written reasons (T30).
- Architecture seams → record as deferred `3.68.0` decisions (T32).
- Release cadence → one tag/release/publish per phase; **pause for user confirmation before any push, tag, publish or release.**
- Live provider calls → none without explicit approval (T33).
- Colours → tokenize clear violations, document deliberate terminal accents (T25).
- Stale plan boxes → tick as historical with a pointer to the Result section (T27).

## Phase 0 — Prove and land the `3.67.0` tool contract
- [x] T01 forced-refusal status 501 + wire test
- [x] T02 declared names after normalization
- [x] T03 streaming note names the serving attempt
- [x] T04 non-tautological behavioural caps guard
- [x] T05 guardToolStream unit tests + cross-chunk finish reason
- [x] T06 `/v1/responses` tool-note test
- [x] T07 forced choice with no tools
- [x] T08 OpenCode forced-call claim
- [x] T09 packaged desktop loads Tools
- [x] T10 caps guard vs gateway registry
- [x] T11 Cline twin drift guard
- [x] T12 tool-phase dead code and stale comments
- [!] Checkpoint 0: `pnpm verify` exit 0, `pnpm app:check` exit 0 — commit/tag/release/publish paused for user confirmation

## Phase 1 — Dashboard truthfulness
- [x] T13 Settings Test connection
- [x] T14 Settings switch unknown state
- [x] T15 ProvidersPage notice timers
- [x] T16 TokenSaver partial response
- [x] T17 webp polarity (converted beatapi/Tirina to PNG so the polarity plugin measures them; assets staged)
- [x] T18 e2e toast exemption (removing it exposed a malformed PATCH stub, fixed in the harness)
- [x] T19 route constants + docs bidirectional
- [x] T20 Models dialog a11y
- [x] Checkpoint 1: `pnpm verify` exit 0; keys button sweep green; full e2e pending at final checkpoint; release 3.67.1 paused for user confirmation

## Phase 2 — Gateway guards and coverage
- [x] T21 regex routes visible to guard (three routes rewritten as literal dispatch + registration guard added)
- [x] T22 thin security-route tests (IPv4-mapped SSRF case, MCP method/body refusals)
- [x] T23 e2e route/baseline gaps (home + token saver added to smoke and button sweeps; two visual fixmes documented with measured pixels)
- [x] T24 dead UI code and stale comments
- [x] T25 tokenize colours and port hints
- [x] Checkpoint 2: `pnpm verify` exit 0; full e2e pending at final checkpoint; release 3.67.2 paused for user confirmation

## Phase 3 — Docs, process and release hygiene
- [x] T26 documentation truth pass
- [x] T27 stale plan boxes
- [x] T28 release/analysis script fragility
- [x] T29 CI tool tests and docker tag guard
- [x] Checkpoint 3: `pnpm verify` exit 0; docs-only except CI/script refinements; release paused for user confirmation

## Phase 4 — Deferred items and human decisions
- [x] T30 security limitation disposition (accepted with reasons in SECURITY.md)
- [x] T31 re-verify historical open items (Kiro tools and hedging confirmed resolved; dispositions in scan doc)
- [x] T32 architecture seam decision (deferred to 3.68.0 in architecture doc)
- [!] T33 ZCode usage recheck — blocked on quota reset and user-approved live turn
- [x] Final checkpoint: `pnpm verify` exit 0, `pnpm app:check` exit 0, `pnpm test:e2e` 29 passed / 2 skipped (documented visual fixmes)

## Log
- 2026-11-18 — Scan complete; baseline `pnpm verify` exit 0; work not started.
- 2026-11-18 — Phase 0 implemented: 12 tasks green, each with a failing-test-first reproduction where behaviour changed. `pnpm verify` and `pnpm app:check` pass. Release paused for user confirmation.
- 2026-11-18 — Phases 1–4 implemented: 20 more tasks green, T33 blocked on a user-approved live turn. Final gates: `pnpm verify` 0, `pnpm app:check` 0, `pnpm test:e2e` 29 passed / 2 skipped. Nothing committed, tagged, pushed, released or published — all release steps await your order.
