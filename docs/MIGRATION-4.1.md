# Migrating to 4.1.0

4.1 adds spend accounting. Nothing changes for a key that has no budget and no allowlist; every new
restriction is opt-in and absent by default.

## What is new

- **Attribution.** Every usage record written from 4.1 carries `actor` (`key`, `dashboard` or
  `anonymous`), and — for a key — `apiKeyId`, `apiKeyPrefix` and `workspaceId`. Records written
  before 4.1 have no attribution and are grouped as `unattributed`, never as zero spend.
- **Spend ledger.** `<dataDir>/spend.json` (or the `spend` document in `state.db` when
  `OMNIHILBRAS_STATE_BACKEND=sqlite`) keeps one bucket per scope, id and UTC day for 400 days. It is
  separate from `usage.json` on purpose: usage is bounded to the last thousand requests, so a month
  budget cannot read it.
- **Budgets.** `PATCH /v1/keys/:id` with `{"budget":{"usd":5,"period":"month"}}`; a workspace may
  carry a default budget that its keys inherit. Dollars are enforced before dispatch against a
  worst-case reservation and settled from the actual usage record. A refusal is
  `402 BUDGET_EXCEEDED` (or `429 QUOTA_EXCEEDED` for a token quota) with remaining and reset headers.
- **Token limits.** `tpm` on a key, next to the existing `rpm`.
- **Allowlists.** `allowedProviders`, `allowedModels` (globs) and `allowedRoutes` on a key.
- **`GET /v1/spend`.** Owner-only: spend and remaining budget for one key or workspace.

## What to do before relying on it

1. Open **Keys**, choose **change** on a key, and set a dollar budget and period.
2. Check **Usage** for the new attribution columns; a request made by a key should say which key.
3. If you use SQLite state, both the ledger and the usage attribution follow the same backend.

## Deliberate limits

- Spend is computed from prices the provider published for the connection's model metadata. A model
  with no quote increments `unpricedRequests` and contributes no dollar amount — it is not zero.
- A budget reservation is a worst-case estimate; a request already dispatched settles when it
  completes. A crashed reservation expires and is reported as a hold until it does.
- Dashboard requests are not budgeted. A budget belongs to a key; the dashboard's loopback traffic
  has no key.
- Windows are UTC.
