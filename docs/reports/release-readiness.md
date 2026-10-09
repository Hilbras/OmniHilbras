# Documentation and release readiness

Phase 10 evidence. Measured against the packages and the tests at the commit that adds this file.

## Source of truth

| Claim | Where it is stated | Measured value | Agrees? |
| --- | --- | --- | --- |
| Gateway / monorepo Node requirement | root `package.json` `engines`, `.nvmrc`, CI | Node 24 | yes |
| SDK Node requirement | `packages/omnihilbras-sdk/package.json`, its README | `>=20`, tested on 20, 22, 24, 26 | yes |
| SDK Node requirement, in the spec | `docs/SPEC-SDK.md` | was "Node.js 24+" for the whole project | **corrected**: now states the SDK floor and the gateway requirement separately |
| Adapter and fixture counts | `tasks/plan.md`, guarded by `documentation-counts` and `documentation-honesty` | 5 pinned of 14 considered | yes |
| Test counts in documents | guarded by `documentation-counts` ("no document states a test count as a bare number") | not quoted | yes |
| Usage record fields | `docs/SPEC-SDK.md` | documents `requestId` and `path` | yes, added in 39aed80 |

## What was changed here

The spec said the whole project needed Node 24, which was true of the gateway and the tooling but not of the published
SDK. A reader would have thought the SDK needed 24. The spec now states both requirements.

## Release steps, as they stand

The repo's own release checklist (`AGENTS.md`) requires, for each release: `pnpm verify`, documentation updated, a
version bump, a commit and tag, a GitHub release, and an npm publish confirmed against the registry. Those steps reach
outside this machine, so they are not performed here. The verify step passes on the tree this report is written against.

## Not done

- The version bump, tag, GitHub release and npm publish are not performed. They need an explicit decision.
- Changelog and migration notes for the behaviour changes in this roadmap (the Host check, the dashboard token, the DNS
  destination check, the usage record fields, and the `Retry-After` detail) have not been written.
- The F5 DNS-rebinding race remains open, pending the `undici` decision.
- The executor does not yet honour `Retry-After`, pending a decision.
