# OmniHilbras ↔ 9router parity scorecard

This is the finish line for the parity loop in `tasks/parity-loop/README.md`. Each cycle re-measures
**both** trees at their current commits and replaces the scores below. The loop stops only when every
criterion is at least level 4 **and** OmniHilbras is not behind 9router on any row.

Evidence must be a path + line or a measured command output. "We think" is not a score.

| # | Criterion | 9router | OH | Evidence (cycle 4) | OH ≥ 9R? |
|---|---|---|---|---|---|
| 1 | Working provider coverage on live requests | 3 | 3 | `docs/reports/parity-cycle-4-system.md:63,110-115,153-163`: 148 registry ids vs 62 cards, no live calls | = |
| 2 | Credential validation: real probe vs public catalog | 3 | 4 | `parity-cycle-4-system.md:64,158-161,167-177`; declared strategies beside factories, real probes | yes |
| 3 | Model-ID / upstream-ID / capability mapping | 4 | 4 | `parity-cycle-4-system.md:65,123-128`; parsing improved, family patterns still 9R-only | = |
| 4 | Tool calling breadth and end-to-end reliability | 4 | 4 | `parity-cycle-4-system.md:66,134-140`; cloaking and the supervised MCP bridge now present | = |
| 5 | Failover and multi-account rotation | 4 | 4 | `parity-cycle-4-system.md:67,99-104`; smart/fusion committed and exercised by the gateway tests | yes |
| 6 | Streaming / protocol surfaces (chat, Messages, Responses) | 4 | 3 | `parity-cycle-4-system.md:68,142-149`; the report says the video route refuses and systemone is absent | no |
| 7 | Web-session, free-tier and special-provider support | 4 | 3 | `parity-cycle-4-system.md:69,113-115,155-163`; 115 registry ids without an OH counterpart | no |
| 8 | Observability: honest records, failure reasons, logs | 3 | 4 | `parity-cycle-4-system.md:70,181-190`; redacted request details | yes |
| 9 | Dashboard and operator surfaces | 4 | 3 | `parity-cycle-4-system.md:71,181-190`; CLI-tool configurators/translator inspector absent | no |
| 10 | Security at rest and in browser | 2 | 4 | `parity-cycle-4-system.md:72,167-177`; guards green except the release trail | yes |
| 11 | Test/CI gate that actually runs and fails | 2 | 4 | `parity-cycle-4-system.md:73,194-205`; 1255 + 967 green, repo suite has 1 real failure, so not 5 | yes |
| 12 | Release discipline and audit trail | 2 | 1 | `parity-cycle-4-system.md:74,199-210,216-220`; tag/version mismatch and two npm gaps | no |

Scale: 0 = absent, 1 = declared but broken, 2 = works for the common case, 3 = works with guards,
4 = measured across providers with regression tests, 5 = better than the reference implementation.

## History

Cycle 0: baseline created. No scores yet; cycle 1 fills them from both trees before changing code.

Cycle 1: implementation committed at `bcd6222d` and tagged `v3.96.0`; its four closed rows were
smart/fusion routing, complete Responses SSE events, `/v1/fetch` and redacted request details. The
scorecard and state were not advanced by that commit.

Cycle 2: taken from `docs/reports/parity-cycle-2-system.md:9-22,50-75`, which re-measured both trees
without running `pnpm verify`. Rows 6, 7, 9 and 12 kept the loop running; row 12 was a regression
introduced by cycle 1's release (a GitHub release without the npm version).

Cycle 3: the provider-by-provider report `docs/reports/parity-cycle-3-providers.md` recorded 33 shared
ids, 29 OH-only ids and 115 9router-only ids, and ranked the xai, kimi and provider-gap items.

Cycle 4 (this scoring): the twelve rows above are the section 1 table of
`docs/reports/parity-cycle-4-system.md:61-76`, with its section references replaced by the line ranges
that contain the evidence. Row 12 drops to level 1 because `v3.97.0` names a commit whose own manifest
says `3.96.0` and two tagged versions are absent from npm
(`docs/reports/parity-cycle-4-system.md:199-210,216-220`). Rows 6, 7, 9 and 12 keep the loop running.
These are the report's measurements, not a claim that `pnpm verify` ran here.

Post-scoring repair: after this scoring, commit `6a4484d4` carried the missing `3.97.0` bump, tag
`v3.97.0` was recreated there and force-pushed to origin, the existing GitHub release still names it,
and `npm view @hilbras/omnihilbras@3.97.0 version` resolves `3.97.0`. The working tree moved to
`3.98.0` for the next release; `node --test tests/release-trail.test.js` is 5/5 and `pnpm verify`
exited 0. The rows above are deliberately left as the cycle-4 measurement. The `v3.96.0` npm gap is
still open and unexempted, so `pnpm release:audit` still exits 1 on that one tag.

Correction to the cycle-4 evidence: the report's §5 says the video route "still refuses every request"
(`:145-146`) and scorecard row 6 repeats that. The committed code already implements a real xAI video
adapter (`Kernel/SDK/xai/adapter/index.ts:87-135`), route (`Kernel/API/src/routes/video.ts:130-146`) and
scripted-transport tests (`Kernel/API/test/video-route.test.js`); the row-6 score is kept as the
cycle-4 measurement but its video half should not be trusted. `systemone` remains absent.
