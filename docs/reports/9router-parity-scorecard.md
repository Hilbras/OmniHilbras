# OmniHilbras ↔ 9router parity scorecard

This is the finish line for the parity loop in `tasks/parity-loop/README.md`. Each cycle re-measures
**both** trees at their current commits and replaces the scores below. The loop stops only when every
criterion is at least level 4 **and** OmniHilbras is not behind 9router on any row.

Evidence must be a path + line or a measured command output. "We think" is not a score.

| # | Criterion | 9router | OH | Evidence (this cycle) | OH ≥ 9R? |
|---|---|---|---|---|---|
| 1 | Working provider coverage on live requests | 0 | 0 | cycle 1 measures | pending |
| 2 | Credential validation: real probe vs public catalog | 0 | 0 | cycle 1 measures | pending |
| 3 | Model-ID / upstream-ID / capability mapping | 0 | 0 | cycle 1 measures | pending |
| 4 | Tool calling breadth and end-to-end reliability | 0 | 0 | cycle 1 measures | pending |
| 5 | Failover and multi-account rotation | 0 | 0 | cycle 1 measures | pending |
| 6 | Streaming / protocol surfaces (chat, Messages, Responses) | 0 | 0 | cycle 1 measures | pending |
| 7 | Web-session, free-tier and special-provider support | 0 | 0 | cycle 1 measures | pending |
| 8 | Observability: honest records, failure reasons, logs | 0 | 0 | cycle 1 measures | pending |
| 9 | Dashboard and operator surfaces | 0 | 0 | cycle 1 measures | pending |
| 10 | Security at rest and in browser | 0 | 0 | cycle 1 measures | pending |
| 11 | Test/CI gate that actually runs and fails on regressions | 0 | 0 | cycle 1 measures | pending |
| 12 | Release discipline and audit trail | 0 | 0 | cycle 1 measures | pending |

Scale: 0 = absent, 1 = declared but broken, 2 = works for the common case, 3 = works with guards,
4 = measured across providers with regression tests, 5 = better than the reference implementation.

## History

Cycle 0: baseline created. No scores yet; cycle 1 fills them from both trees before changing code.
