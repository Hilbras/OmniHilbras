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

1. `pnpm verify` passes. That is `version:check`, then `typecheck`, then `test`,
   then `build`, in that order — the order that fails fastest. CI runs the same
   command, so a change that passes locally passes in CI by construction.
2. `README.md`, `docs/SPEC-SDK.md`, `docs/architecture/`, and `tasks/` reflect the
   new behavior.
3. Version bumped per the table above, and `pnpm version:check` passes. The
   workspace version is duplicated in three `package.json` files, the README
   headline, and the `X-CLIENT-VERSION` constant; the README once advertised
   `0.2.0` while the project was at `1.12.2`, which is why the check exists. Run
   `pnpm version:fix` to rewrite the derived copies, then re-run the check.
4. Committed, tagged `v<version>`, and pushed to `origin/main`.
5. A GitHub release exists for the tag with notes that say what changed and how
   to verify it.
6. `npm publish --access public` from `packages/omnihilbras-sdk`, then confirm
   the version resolves from the registry.

**Steps 4–6 are required after every phase, every checkpoint, and every task
group that changes behaviour.** A phase is not done when its code is merged; it
is done when the tag is on `main`, the release exists, and the version resolves
from the registry. Leaving any of the three for later is how a tag ends up
pointing at something nobody published, and a published version ends up with no
release explaining it.

**`npm publish` reporting success is not evidence the version exists.** It has
twice printed `+ @hilbras/omnihilbras@<version>` while the version was absent
from the registry — the tarball is staged and finalised minutes later, and a
re-publish during that window fails with `409 Cannot publish over previously
staged version`. So step 6's "confirm" is a real check, not a formality:

```bash
npm view @hilbras/omnihilbras@<version> version   # poll until it echoes the version
```

A `409` means *wait*, not *retry harder* and not *bump the version*. Every
version between 1.16.0 and 1.32.0 has all three steps; this audit reproduces it:

```bash
for t in $(git tag --sort=v:refname); do
  v=${t#v}
  printf '%-8s %s %s %s\n' "$v" \
    "$(git merge-base --is-ancestor "$t" origin/main && echo pushed || echo MISSING)" \
    "$(gh release view "$t" >/dev/null 2>&1 && echo released || echo MISSING)" \
    "$(npm view @hilbras/omnihilbras@$v version 2>/dev/null | tail -1 | grep -qx "$v" && echo published || echo MISSING)"
done
```

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
- A provider card in `src/data/providers.ts` is catalog metadata. Before a card
  claims a working connection, the gateway must be able to serve that provider:
  a card with no connection stays `status: 'available'` with `—` metrics, and an
  auth mode with no flow behind it (currently `OAuth`) must disable Save in
  `AddProviderModal` and say so.

## Commands

```bash
pnpm install
pnpm dev            # dashboard + marketing site on :5173
pnpm dev:gateway    # local gateway on 127.0.0.1:8787
pnpm typecheck
pnpm test           # SDK then gateway
pnpm build
```
