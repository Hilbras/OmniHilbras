# Plan: explicit multi-account isolation

**Status:** in progress — Phases 1–3 implemented; Phase 4 next

## Context

A `GatewayConnection` is already the account record. It has its own id, credential, model list, priority,
rate limit, enabled flag and `proxyPool` name. Two connections for one provider are already stored,
tested and attributed separately. This plan makes that separation explicit in routing, limits, UI and
usage instead of adding a second parallel "account" table.

## Non-goals

- No account rotation to evade a provider's quota, ban or identity checks.
- No fingerprint spoofing or browser-profile sharing.
- No cross-account retry after `AUTHENTICATION_FAILED`; a dead credential is a fact about one account.
- No provider-neutral core lookup of another provider's credential, except the existing explicit alias.

If a provider's terms forbid multiple accounts, the correct answer is a team/org agreement, not better
isolation.

## Phase 1 — account identity and UI

- Treat each `GatewayConnection` as an account; keep ids stable across rename and credential refresh.
- Show account label, email or account id, credential type, priority, proxy pool and enabled state per
  row on the provider page.
- Add an explicit **account** term to the provider page where the UI currently says "connection" for
  two different concepts.
- Keep the existing rule that a provider card count is the number of saved accounts, not one.
- Tests: two accounts of one provider render two rows; a disabled account is named separately; an
  account's own test never reports another account's result.

## Phase 2 — explicit account routing

- Add `connectionId` as an explicit request selector, for example
  `x-omnihilbras-connection: <connection-id>`.
- The header narrows route candidates to that connection. Unknown, disabled, credential-less or
  model-less accounts are refused with a named error, not silently replaced.
- Keep provider selection (`x-omnihilbras-provider`) and model routing unchanged when the header is
  absent.
- Do not fall back to another account when the header named one.
- Tests: header picks the second account; unknown id is a 400; disabled/no-credential is a named
  rejection; no header keeps priority routing.

## Phase 3 — authentication isolation

- Pin the retry policy: `AUTHENTICATION_FAILED` is terminal for that route and must not dispatch a
  second account.
- Login refusal stays attached to the connection, not the provider's aggregate health.
- Test: two accounts, first refuses the credential, second must receive zero dispatches; the error
  names the first connection.
- Test: a rate limit or 5xx may fail over, but the attempt ledger names each account.

## Phase 4 — per-account limits

- `resilience.requestsPerMinute` already exists per connection; keep it keyed by connection id.
- Add `maxConcurrentRequests` to connection resilience, with `0` meaning no cap.
- Enforce concurrency at dispatch time and release it on success, failure, cancellation and timeout.
- A refused concurrency slot is not counted as a provider failure and does not consume RPM budget.
- Tests: two accounts with independent concurrency; one saturated account does not block the other;
  a released slot is reusable; auth failure does not release another account's slot.

## Phase 5 — network isolation

`proxyPool` is currently stored and shown but not enforced by any transport. This phase must not pretend
otherwise.

- Define a per-account egress configuration; if credentials are needed, keep them in the vault, never in
  the connection record.
- Thread the selected egress through `ProviderRequestContext` and the vendored transports, including
  streaming and OAuth renewal.
- Record the egress name on the attempt and usage record.
- If a transport cannot enforce egress, refuse the connection rather than silently sending it direct.
- Tests: a proxied account uses the proxy; a direct account does not; a proxy failure fails that
  account only; no credential appears in logs or usage.

## Phase 6 — usage, observability and release

- Usage is already recorded with `connectionId`; add account-scoped reads and a per-account usage view.
- Surface per-account: requests, tokens, cache, failures, last error, rate-limit waits and egress.
- Provider cards report account count and the worst known state, never a merged green claim.
- Documentation: README, `docs/SPEC-SDK.md`, `docs/architecture/README.md`, release notes.
- Run `pnpm verify`; release the change with a version bump.

## Guardrails

- `pnpm verify` must pass before completion.
- Every new route/header gets a SPEC line and a gateway test.
- No secret reaches browser storage or a usage record.
- Existing provider aliases (`clinepass` → `cline`) remain explicit and are not generalised.

## Current measurements to keep honest

- `GatewayConnection` is already separate per account; the vault is keyed by connection id.
- `UsageRecord.connectionId` already exists.
- `proxyPool` is persisted but no transport reads it.
- `requestsPerMinute` is enforced per connection by the gateway; concurrency is not.
- `AUTHENTICATION_FAILED` is in the terminal route codes; pin it with a test before changing retry logic.
