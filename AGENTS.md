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
   **That sentence was false until 1.33.2.** CI had failed all 25 runs it had
   ever executed, including the commit that introduced it, while every local
   run passed — because `pnpm typecheck` typechecked the dashboard before
   anything built the SDK, so it read a `dist/` that exists in a working tree
   and not in a checkout. `build:sdk` now runs first, and the SDK build empties
   `dist/` before emitting, so there is no leftover state for a local tree and
   a fresh checkout to disagree about. **Check `gh run list` before shipping
   rather than assuming this sentence is still true.**
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
  **This is asserted, not promised:** `tests/browser-storage.test.js` requires every
  `localStorage`/`sessionStorage` key in `src/` to be on a two-entry allowlist — a sidebar
  preference and a theme — with no credential-shaped name and no credential-shaped value, and
  asserts `sessionStorage`, `document.cookie` writes, IndexedDB and the Cache API at **zero**. It
  splits camelCase before matching, so `apiKey` and `REFRESH_TOKEN` are caught; a `\bkey\b` pattern
  misses both. To add a key, add it to the allowlist with a sentence saying what it holds, and
  expect a reviewer to disagree with that sentence.
- Never put a token, key, or password in a commit, a file, or a chat message.
  Use `npm login` or a local environment variable.
- No credential-shaped string is committed. **This is now a check, not a ritual** —
  `tests/no-secrets.test.js` scans every tracked file for 15 credential shapes (gateway keys,
  npm, GitHub, OpenAI, Anthropic, OpenRouter, AWS, Google, Slack, Discord, private-key
  blocks, JWTs, bearer values) and runs in CI on every push and pull request. The
  four-pattern `git grep` this replaces was carried out by hand before every push, which
  is a thing that is skipped under deadline and never runs on the twenty commits between
  the one you remembered and the tag you pushed. A key that reached a commit has to be
  **rotated**, not deleted — assume it is compromised. If the scan is wrong, widen the
  pattern; do not add an exemption without saying what the string is and why it is dead.

## Boundaries

- Provider-specific wire formats stay inside `packages/omnihilbras-sdk/src/adapters/`.
  The gateway service and SDK index must stay provider-neutral.
- Real requests only. A test, health check, or simulated result must not be presented as a live one.
  A new provider request costs money, so say so. **Asserted where it is easiest to get wrong:**
  `tests/dashboard-truthfulness.test.js` fails if a success state in `src/` is set inside a timer
  callback. `AddProviderModal`'s Check button used to wait 850 ms and call `setTestState('success')`
  for every provider except OpenRouter, so a key that was any string at all produced a green
  "Key looks valid" — and only one provider's key was really checked. It now asks the gateway, for
  every provider. If a check cannot be performed, say so; do not simulate the result.
- New gateway routes need tests in `apps/gateway/test/` and a line in
  `docs/SPEC-SDK.md`. **Both are now checked, not requested:**
  `tests/gateway-routes.test.js` fails if a served path has no spec line, if the spec
  advertises a path the gateway does not serve, or if a route path is built from
  something that is not a literal or a named constant. A new route fails CI until the
  spec line exists, which is the point — the instruction is not a substitute for the
  check, the check is what runs when the instruction is forgotten.
- The dashboard has one React Router entry at `/dashboard`. Do not add
  `*.html` entry files or hash routes.
- A provider card in `src/data/providers.ts` is catalog metadata, and it is the state a card shows
  when **the gateway has no connection for that provider** — `ProvidersPage` seeds from it and
  `mergeGatewayConnections` overlays only providers that have one. So **no card in it may claim a
  measurement**: `status: 'available'`, `models: '—'`, `latency: '—'`, `requests: '0'`,
  `lastUsed: 'never'`, `health: 0`, `modelList: []`. One card used to read `attention`, `6 models`,
  `92 ms`, `1,417` requests, `2 min ago` and three named models, so a user with no Ollama connection
  was shown a plausible week of traffic for a runtime they had never run.
  `tests/provider-cards.test.js` asserts all of that, and also that a card claiming `auth: 'OAuth'`
  has a matching `/v1/oauth/:id/start` route, that a card pasting a cookie has a descriptor in
  `webSessionProviders.ts` whose routes the gateway really serves, and that every card has a bundled
  mark **or** an `initial` for `ProviderMark` to fall back on.
  **The clause this replaces — "an auth mode with no flow behind it (currently `OAuth`) must disable
  Save in `AddProviderModal`" — described code that does not exist and a parenthetical that had gone
  false.** `canSave` is computed from form fields alone and knows nothing about flows, and three
  providers have since grown real OAuth flows. If you add an auth mode with no collector, disable Save
  and say so in the UI, and add the mode to the set the card test knows about.
- `public/providers/` is **input, not build output**. The `logoPolarity()` plugin reads it and
  writes `src/lib/logoPolarity.generated.ts`; nothing writes into the directory. Never stage with
  `':(exclude)public/providers'` — that silently dropped 141 required assets from 18 releases, two
  of which the dashboard renders directly, and a missing logo is a browser 404 that no build reports.
  `tests/dashboard-assets.test.js` asserts every rendered mark is committed; if it has to be
  disabled to make a commit pass, the exclusion is the bug.

## Commands

```bash
pnpm install
pnpm dev            # dashboard + marketing site on :5173
pnpm dev:gateway    # local gateway on 127.0.0.1:8787
pnpm typecheck
pnpm test           # SDK then gateway
pnpm build
```
