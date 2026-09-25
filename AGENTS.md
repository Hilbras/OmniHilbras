# AGENTS.md

Working agreements for this repository. Follow them unless a task explicitly
overrides one.

## Versioning

Every update ships with a version bump and a release. The bump is chosen by the
size of the change, not by the number of files touched:

| Change | Bump | Example |
| --- | --- | --- |
| Big: breaking API, removed or renamed public surface, behavior a consumer must adapt to | `x.0.0` | `0.1.0` → `1.0.0` |
| Medium: new capability, new route, new option, new page — backward compatible | `0.x.0` | `0.1.0` → `0.2.0` |
| Small: fix, refinement, docs, internal cleanup — no new behavior | `0.0.x` | `0.1.0` → `0.1.1` |

`x`, `x`, and `x` are the last digit of the major, minor, and patch position.

The workspace version is kept in step across `package.json`,
`packages/omnihilbras-sdk/package.json`, and `apps/gateway/package.json`. The
published artifact is `@hilbras/omnihilbras`; its version is the release
version.

## Definition of done for a change

1. `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
2. `README.md`, `docs/SPEC-SDK.md`, and `tasks/` reflect the new behavior.
3. Version bumped per the table above.
4. Committed, tagged `v<version>`, and pushed to `origin/main`.
5. A GitHub release exists for the tag with notes that say what changed and how
   to verify it.
6. `npm publish --access public` from `packages/omnihilbras-sdk`, then confirm
   the version resolves from the registry.

Never publish a version that does not exist on GitHub, and never tag a commit
that is not on `main`.

## Security rules

- Never commit credentials. The gateway vault and key material live in
  `$XDG_CONFIG_HOME/omnihilbras` and are gitignored.
- Provider credentials and gateway keys are never handed to browser storage.
- Never put a token, key, or password in a commit, a file, or a chat message.
  Use `npm login` or a local environment variable.
- Before any push, scan the tree for secret-shaped strings:
  `git grep -nEI "ohk_[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}"`

## Boundaries

- Provider-specific wire formats stay inside `packages/omnihilbras-sdk/src/adapters/`.
  The gateway service and SDK index must stay provider-neutral.
- Real requests only. A test, health check, or simulated result must not be
  presented as a live one. A new provider request costs money, so say so.
- New gateway routes need tests in `apps/gateway/test/` and a line in
  `docs/SPEC-SDK.md`.
- The dashboard has one React Router entry at `/dashboard`. Do not add
  `*.html` entry files or hash routes.

## Commands

```bash
pnpm install
pnpm dev            # dashboard + marketing site on :5173
pnpm dev:gateway    # local gateway on 127.0.0.1:8787
pnpm typecheck
pnpm test           # SDK then gateway
pnpm build
```
