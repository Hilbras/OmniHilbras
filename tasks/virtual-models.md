# Plan: virtual models (`oh/<id>`)

**Status:** complete — all phases implemented; `pnpm verify` passes

## Product shape

A virtual model is one public model ID mapped to several saved provider accounts and upstream model IDs.
Clients send `oh/<name>`; the gateway resolves the enabled mapping and routes the request to one of its
targets. Disabling the virtual model restores ordinary concrete routing.

Example:

```text
oh/chat
  → openai       / gpt-4o
  → openrouter   / openai/gpt-4o
  → ollama       / llama3.3
```

All virtual IDs must begin with `oh/`. A public ID that does not start with it is rejected.

## Model record

```text
VirtualModel
  id             "oh/chat" (unique, required)
  name           display name
  enabled        boolean
  strategy       priority | round-robin | fastest
  targets[]
    connectionId
    upstreamModelId
    priority
    enabled
  createdAt / updatedAt
```

- At least one enabled target is required to enable a model.
- A target must name a saved connection that exists and lists the upstream model ID.
- Duplicate `connectionId + upstreamModelId` targets are rejected.
- No credentials are stored in this record; credentials remain on the connection.
- Persist as `virtual-models.json` in the gateway data directory, atomic write, owner-only mode.

## Phase 1 — store and contract

- Add `VirtualModel`, `VirtualModelTarget`, `VirtualModelStrategy` and a `VirtualModelStore` interface.
- Add `InMemoryVirtualModelStore` for tests and `LocalVirtualModelStore` for `$XDG_CONFIG_HOME`.
- Validate `oh/` prefix, unique id, target shape, priorities and at least one target.
- Tests: prefix rejection, duplicate id, missing connection, missing upstream model, atomic persistence.

## Phase 2 — routing

- Add `model?: string` to `RouteCandidate`; `RequestExecutor` dispatch passes `candidate.model` as the
  upstream model when present.
- Add a virtual-model resolver between `planRoute` and `routing.plan`.
- Enabled virtual model takes precedence over concrete model resolution.
- Candidate construction:
  - find each target's connection;
  - require enabled, credentialed, model-listed target;
  - use the target upstream model as the candidate override;
  - respect target priority, account health, rate limit and concurrency.
- Strategies:
  - `priority`: target priority, then connection priority;
  - `round-robin`: rotate targets, preserving priority as a fallback;
  - `fastest`: measured latency first, then priority.
- Authentication failure stays on one account. No cross-account retry.
- Disabled virtual model: no candidates from the alias; concrete routing continues.
- Tests: two providers behind `oh/model`, each receives one dispatch under round-robin; priority order;
  unknown/disabled targets skipped; disabled virtual falls back; upstream override reaches adapter;
  auth failure does not try another target.

## Phase 3 — management API

- `GET /v1/virtual-models`
- `POST /v1/virtual-models`
- `PUT /v1/virtual-models/:id`
- `DELETE /v1/virtual-models/:id`
- `POST /v1/virtual-models/:id/test` (optional; uses the normal dispatch path, never a simulated result)
- Management auth and origin gate, same as connections/settings.
- `GET /v1/models` includes enabled virtual models with `virtual: true` and `providers: [...]`.
- Tests: CRUD, auth, invalid prefix, target validation, `/v1/models` exposure, no credential leakage.

## Phase 4 — Models page

- New route `/dashboard/models`, nav entry **Models**.
- One card per virtual model:
  - public ID, display name, enabled toggle, strategy;
  - provider/account badges and target count;
  - target list with upstream model IDs and priorities;
  - edit/delete actions; empty state with **Create model**.
- Create/edit drawer or dialog:
  - ID input with fixed `oh/` prefix (the user types the suffix);
  - display name;
  - target rows: saved connection picker + upstream model picker;
  - strategy, priority, enabled;
  - validation before save.
- A disabled card is visibly disabled and does not claim routing.
- Dashboard client functions and types for all four routes.
- Tests: source-level route/nav wiring and client contract; UI guard for `oh/` prefix.

## Phase 5 — docs and release

- README: virtual models section, example request, strategies and precedence.
- `docs/SPEC-SDK.md`: CRUD routes, record shape, precedence, target selection, failure behavior.
- `docs/architecture/README.md`: where virtual resolution sits and why `RouteCandidate.model` exists.
- Release notes.
- Version bump; `pnpm verify`.

## Non-goals

- No account rotation, fingerprint spoofing or proxy claims.
- No hidden fallback to a different account after `AUTHENTICATION_FAILED`.
- No virtual model without `oh/`.
- No storing provider credentials in a virtual-model record.
