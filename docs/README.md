# OmniHilbras documentation

This directory is the technical reference behind the [README](../README.md). It describes what is built,
what is measured, and which limits are deliberate.

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the product and install it | [`../README.md`](../README.md) |
| Call the gateway or add a route | [`SPEC-SDK.md`](./SPEC-SDK.md) |
| Understand the layer boundaries | [`architecture/README.md`](./architecture/README.md) |
| Add or debug a provider | [`SPEC-SDK.md`](./SPEC-SDK.md) and [`architecture/9router-provider-catalog.md`](./architecture/9router-provider-catalog.md) |
| Work on embeddings | [`architecture/embeddings-plan.md`](./architecture/embeddings-plan.md) |
| Run a one-off investigation | [`tools.md`](./tools.md) |
| Report a vulnerability | [`../SECURITY.md`](../SECURITY.md) |

## Reference

### Gateway and SDK

- [`SPEC-SDK.md`](./SPEC-SDK.md) — the route contract, provider adapter shape, error codes, authentication,
  token saver endpoints, success criteria and protocol references.
- [`architecture/README.md`](./architecture/README.md) — measured service boundaries, provider-neutrality
  evidence and the current gaps.
- [`architecture/embeddings-plan.md`](./architecture/embeddings-plan.md) — how embeddings dispatch and why.
- [`architecture/audit-9router-borrowing.md`](./architecture/audit-9router-borrowing.md) — what was borrowed
  from the reference implementation, and what was deliberately left behind.
- [`architecture/phase6-plan.md`](./architecture/phase6-plan.md) — the phase plan for the current restructuring.

### Provider catalog

[`architecture/9router-provider-catalog.md`](./architecture/9router-provider-catalog.md) records the provider
catalog, model families, endpoints and known auth shapes. A catalog entry is metadata, not a measurement; a
provider card shows `—` until a real connection exists.

### Reports

The files under [`reports/`](./reports/) are point-in-time engineering reports, not live claims. Each names what
was measured and when:

- [`reports/performance-baseline.md`](./reports/performance-baseline.md)
- [`reports/streaming-reliability.md`](./reports/streaming-reliability.md)
- [`reports/request-execution.md`](./reports/request-execution.md)
- [`reports/observability-usage.md`](./reports/observability-usage.md)
- [`reports/provider-lifecycle.md`](./reports/provider-lifecycle.md)
- [`reports/provider-test-matrix.md`](./reports/provider-test-matrix.md)
- [`reports/dashboard-quality.md`](./reports/dashboard-quality.md)
- [`reports/build-reproducibility.md`](./reports/build-reproducibility.md)
- [`reports/sdk-package-validation.md`](./reports/sdk-package-validation.md)
- [`reports/engineering-hardening-baseline.md`](./reports/engineering-hardening-baseline.md)
- [`reports/release-readiness.md`](./reports/release-readiness.md)

## Documentation rules

1. **A count that can be measured comes from a command.** Prefer “run `pnpm verify`” over quoting a test total.
2. **A route named here must be served.** `tests/gateway-routes.test.js` and `tests/documentation-counts.test.js`
   fail when the docs and the tree disagree.
3. **Finished work has no unticked boxes.** A checklist that reads as complete must be checked; undecided work
   belongs in prose.
4. **Every claim about a provider is about the code path, not the vendor's marketing.** Provider-specific wire
   formats stay in `Kernel/SDK/<provider>/adapter/`.
5. **A missing measurement is not a zero.** Say “not measured” or “not reported” when that is the truth.
