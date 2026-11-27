# Migrating to 4.6.0

4.6 closes the remaining gaps the V5 plan named but the 4.1–4.5.1 slices left partial. No breaking
change.

## Spend on the usage page

`/dashboard/usage` gains an API-key selector that scopes every query to one key, a Key column in the
record table, and a "By key" panel with requests, tokens and cost. `GET /v1/usage` returns `byKey`
with `costUsd`, `pricedRequests` and `unpricedRequests` computed from the same prices as the totals.

## Budget metrics

`GET /metrics` adds `omnihilbras_budget_checks_total` and
`omnihilbras_budget_refusals_total{kind="usd"|"tokens"|"policy"}`. They are counters, not per-key
labels: a key id in a label is unbounded cardinality.

## Budget webhooks

`budget.threshold` now fires once per scope, period and threshold at 80% and 100%, with the spent
and limit amounts. The dedupe key includes the period's reset date, so a hundred refusals in one
minute produce one notification and a new day can alert again.

## Prompts in the backup

The encrypted backup now carries a `prompts` section, read back through the same parser the store
uses, so an edited or corrupted prompt section fails the import rather than half-restoring. A
backup taken before 4.6 simply does not carry it; an absent section leaves the local prompts alone.
