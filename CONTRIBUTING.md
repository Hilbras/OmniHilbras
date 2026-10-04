# Contributing to OmniHilbras

Thanks for looking. This document is short because most of the project already states its own rules — the
useful thing here is to point at them and say which one will stop your change.

## The one rule that is not negotiable

**Real requests only. Never present a simulated, stubbed, or defaulted result as a live one.**

That is the project's single most-repeated principle and it has a measurable consequence: a dashboard must
show what was *measured*, and a missing measurement must be shown as missing rather than filled in. The
Overview page that showed a hardcoded request history behind a range selector that changed a hardcoded number
was deleted rather than kept, and `tests/marketing-claims.test.js` now fails if a false claim is rendered
into the app.

If your change makes a number appear on screen, one of these must be true:

- it came from a measurement the gateway took, or
- the screen says it was not measured.

"There is no provider that reports this" is a legitimate result and must be shown as such.

## Read these before editing

| You are changing | Read first |
| --- | --- |
| anything under `packages/omnihilbras-sdk/src/adapters/` | `docs/SPEC-SDK.md`, and `packages/omnihilbras-sdk/test/fixture-coverage.test.js` |
| routing, retries, hedging, rate limits | the comments on `RequestExecutor` in `apps/gateway/src/request-executor.ts` |
| the dashboard | `AGENTS.md`, and the `file:line` comments in the file you are editing |
| anything that adds a route | `AGENTS.md` § *Boundaries*, plus `tests/gateway-routes.test.js` |

`AGENTS.md` is the working agreement for this repository. It is unusually specific on purpose: nearly every
rule in it exists because the thing it forbids was measured happening.

## Adding a provider

The property this project cares about is that **adding a provider never requires editing the gateway core**.
That is not aspirational — it is what `tests/new-provider-cards.test.js` and the zero-provider-id invariant
check, and 1.43.0 added nine providers without touching core logic.

In practice: add a card to `src/data/providers.ts`. If the provider speaks a protocol no adapter implements,
the generic OpenAI-compatible fallback already routes it — measured in 1.45.0, which showed the gateway
serving all nine with no adapter at all. Write an adapter only when the wire format genuinely differs, and
keep provider-specific formats inside `packages/omnihilbras-sdk/src/adapters/`.

## Tests, and mutation testing

```bash
pnpm install
pnpm verify        # version:check → typecheck → test → build, in that order
```

A test that cannot fail is a comment. In this repository a guard is only considered real once someone has
**reverted the code it guards and watched it go red** — that is recorded in the release notes for every guard
added here, and several of them failed their first mutation test and were repaired as a result.

Three guards in particular have been repaired after a mutation proved them blind, and their comments say so:

- `tests/provider-card-merge.test.js` accepted an invented field because it only denied two names.
- `tests/browser-storage.test.js` missed `` localStorage.setItem(`${PREFIX}apiKey`, v) `` because its parser
  handled quoted literals and identifiers but not template literals.
- `tests/health-verification.test.js` accepted a health check with no declared scope when the status arrived
  through a variable, satisfying a `0 < 0` comparison.

If you add a static guard, plan to mutation-test it before you call it done.

## Commits and releases

Every change ships as its own version, and the definition of done is in `AGENTS.md`. Briefly:

1. `pnpm verify` green.
2. Version bumped, and `README.md` / `docs/SPEC-SDK.md` / `docs/architecture/` / `tasks/` updated to match.
3. Committed, tagged `v<version>`, pushed to `main`.
4. A GitHub release for the tag, with notes saying what changed **and how to verify it**.
5. `npm publish` from `packages/omnihilbras-sdk`, then **confirm the version resolves from the registry**.

Step 5 is not a formality. `npm publish` has twice reported success for a version that was absent from the
registry, because the tarball is staged and finalised minutes later. A `409` on re-publish means *wait*, not
*bump the version*.

## Reporting a bug

Open an issue with: the version, what you did, what you expected, what happened, and the `requestId` from the
response if there was one — it is there precisely so a log can be matched to a request.

For anything that looks like a credential leak or an authentication bypass, do **not** open a public issue.
See [SECURITY.md](./SECURITY.md).

## Code of conduct

Be straightforward and assume good faith. Disagree with the code, not the person — and bring a measurement
when you can, because in this repository "I read it and I think" loses to "I ran it and here is the number".
