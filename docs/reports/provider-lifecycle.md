# Provider lifecycle isolation

Phase 6 evidence. Measured against the code and tests at the commit that adds this file.

| Roadmap item | Status | Evidence |
| --- | --- | --- |
| 6.1 Lifecycle contract | partial | `apps/gateway/src/credential-lifecycle.ts` answers expiry without spending a request, and fails toward "ask the provider" whenever it is unsure. It has no refresh, revoke or validate operation. |
| 6.2 Move provider lifecycle out of the service | **not done** | `service.ts` still holds the provider-specific sign-in and check calls. Moving them is a large refactor, and the roadmap asks for none that are not justified by a measured problem. |
| 6.3 Stable registry | covered | `ProviderRegistry` and `createProviderRegistry` construct the adapters; capability declarations are per adapter |
| 6.4 Architecture regression test | **added** | `apps/gateway/test/shared-execution-has-no-provider-names.test.js` (6): routing, the routing engine, request executor, retry, hedge and rate-limit policies name no provider in executable code |
| 6.5 No external plugins | covered | no plugin loader exists in the tree |

## What the architecture guard found

The shared execution code is already free of provider-name branches. The only matches in the resolver were inside a
documentation example showing the pattern to avoid, which the guard ignores by checking executable code only.

## Not done, and why

Moving the service's per-provider sign-in and health calls behind the lifecycle interface is the largest item in
Phase 6. It touches every provider's connect path, and the roadmap itself says not to rewrite stable components
without a measured problem. No defect in the lifecycle was measured, so the move is deferred, and the central
service stays as it is.

## Still open

- 6.1 refresh and revoke are not behind the lifecycle interface.
- 6.2 the service's provider-specific calls are not moved.
