# Migrating to 4.0.0

4.0 is the V4 platform release. It keeps the local-first install, the inference API and the JSON
vault as defaults, while changing the provider package layout, the identity model and the state
backend behind them.

## Upgrade

```bash
npm install -g @hilbras/omnihilbras@4.0.0
omnihilbras --version
```

A checkout upgrades the same way with `pnpm install && pnpm build`.

## What upgrades automatically

- **The vault.** `connections.json` and `secrets.enc.json` are read through the `StateDocument` seam.
  With `OMNIHILBRAS_STATE_BACKEND=sqlite` the existing files are imported once on first read; the row
  then wins, so a stale file cannot roll a store back. JSON remains the default.
- **API keys.** A key written before roles existed loads as `owner`, which is the historical admin
  credential. No client breaks.
- **Provider cards, capability rows and registry rows.** They are projections of
  `Kernel/SDK/_shared/src/provider-manifests.ts`; there is no migration step for an operator.
- **Inference endpoints.** `/v1/chat/completions`, `/v1/responses`, `/v1/messages`,
  `/v1/embeddings`, `/v1/models`, audio, images, video and provider-prefixed model ids keep their
  shapes.

## What is new and opt-in

| Feature | How |
| --- | --- |
| SQLite state backend | `OMNIHILBRAS_STATE_BACKEND=sqlite` (WAL, `state.db`, bounded event journal) |
| Read-only gateway keys | `POST /v1/keys` with `role: "viewer"` |
| Workspace-scoped keys | `POST /v1/keys` / connection save with `workspaceId` |
| Audit trail | `GET /v1/audit` (owner only) |
| Durable job history | `GET /v1/jobs` (owner only) |
| Route inventory / OpenAPI | `GET /v1/openapi` |
| Command palette | Cmd/Ctrl+K in the dashboard |

## What changed for a consumer

- **Provider packages** import `@omnihilbras/sdk-shared` instead of carrying local copies of
  `types`, `transport`, `openai-compatible`, `responses-lane`, `errors`, `url`, `streaming`,
  `bounded-map` or `model-normalize`. This is internal to the private packages; a consumer of the
  published CLI is unaffected.
- **A viewer key is enforced.** It may read the observation surface and is refused management writes
  and `/v1/keys`, `/v1/backup`, `/v1/oauth`, `/v1/mitm`, `/v1/settings`, `/v1/runtime` with 403.
- **A workspace-scoped key is enforced on connections and keys.** Another workspace's connection is
  a 404, not a leak; a save is forced into the key's workspace.
- **Management writes are audited.** The record is content-free (actor, method, path, status, request
  id) and is not part of the encrypted backup envelope yet.
- **`/v1/openapi` is an inventory, not typed schemas.** It lists every served path and prefix; request
  and response schemas are not generated yet.

## Recommended before upgrading

1. Back up the vault from About → Encrypted backup, or copy the state directory.
2. If enabling SQLite, keep the JSON files until the first successful start has been checked.
3. If minting a viewer key, verify it cannot read `/v1/keys` or write a connection before handing it
   out.

## Known limits in 4.0

- JSON remains the default state backend; the SQLite default flip is a post-4.0 change.
- Workspace scope is enforced on connections and keys, not on usage, logs or every store.
- The audit trail and job history are local and not in the encrypted backup envelope.
- `/v1/openapi` carries paths and prefixes, not request/response schemas.
- Durable job history is a record of passes, not a persistent job queue; catalog refresh and video
  polling remain request-driven.
- The deferred provider lifecycle work beyond `CredentialProvisioner` and the wider design-system
  pass are tracked in `tasks/v4-platform-plan.md`.
