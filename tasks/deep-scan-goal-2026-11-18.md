# Goal — deep-scan remediation plan (2026-11-18)

## Goal statement

Bring the uncommitted `3.67.0` tool-contract phase to a state where its claims are proved by
runtime tests and its documented behaviour matches the wire; fix the dashboard paths that report
success without measuring it; close the gateway guard blind spots and stale documentation; and
leave an honest, prioritized list of the security and product decisions that cannot be closed by
code alone. Every phase ends releasable under the repository's Definition of Done in `AGENTS.md`.

## Success criteria (the plan is done when all of these are true)

1. `pnpm verify` passes from a clean checkout, with the new tool tests run inside it.
2. Every capability claim in `Kernel/Tools/src/caps.ts` and `docs/SPEC-SDK.md` is checked against
   what an adapter actually puts on its wire — including the providers currently untested.
3. No UI control reports a result the gateway did not send; no notice timer can clear a later
   notice; no unguarded nested response field can blank a page.
4. Every route the gateway serves is visible to the route guard, including regex-dispatched ones,
   and every route the dashboard serves is documented.
5. README, SPEC, CONTRIBUTING, NPM-PUBLISH, AGENTS.md and the architecture docs agree on the
   current version, publish state and route surface.
6. The two completed plans' stale checkboxes are reconciled, and no pre-existing task log or plan
   was overwritten.
7. Every deferred item is either fixed, explicitly accepted with a reason in the docs, or recorded
   as a user decision — never silently dropped.
8. A packaged desktop build demonstrably loads `@omnihilbras/tools`, and the e2e suite covers the
   routes and fixes that are claimed covered.
9. Each behaviour-changing phase is committed, tagged on `main`, released on GitHub and published
   to npm (`cli/`) per `AGENTS.md`; the release audit reports no new gap.

## Non-goals

- No provider credentials, live paid requests, or sign-in flows are created by this plan.
- No history rewriting; no republishing of the recorded unrecoverable release gaps.
- No redesign of the dashboard, no new provider integrations, and no re-architecture of the
  gateway. The deferred design items in Phase 5 are decisions, not implementation mandates.
- No edits to `tasks/todo.md` (the refactoring log) or `tasks/plan.md` (the completed original
  plan) beyond adding the new scan documents referenced here.

## Standing constraints

- Follow `AGENTS.md`: version bumps by change size, `pnpm verify` as the gate, docs updated with
  code, one publishable manifest (`cli/`), no credentials anywhere in commits or chat.
- Keep provider-specific wire formats in `Kernel/SDK/<name>/adapter/`; keep the gateway neutral.
- Prefer runtime tests over source-text guards when a guard is added or repaired; keep an existing
  guard if it still catches a real regression.
- Each task ends with a working tree that builds and tests. A revert check is required for every
  behaviour change: remove the fix, confirm the new test fails, restore it.

## Baseline

- Branch `main`, HEAD `v3.66.2`, working tree at `3.67.0`, all changes uncommitted.
- `pnpm build`, `pnpm test`, `pnpm verify`, `pnpm version:check` all pass on the scan tree.
- Detailed evidence: `tasks/deep-scan-2026-11-18.md`.
