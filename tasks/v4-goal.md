# V4 goal

**Ship OmniHilbras 4.0.0 as a durable local platform**: one state engine, one provider core, one identity model, and one real-time experience — without abandoning local-first storage, the zero-dependency CLI bundle, or the asserted-not-promised test culture.

The release is successful only when all of these are true:

1. **One provider core.** The 245 tracked vendored TypeScript files under `Kernel/SDK/*/lib/` collapse to one internal shared package, with a guard that fails if a package reintroduces a local shared copy. A provider is an adapter plus a manifest; adding one requires no Core edit.
2. **One state engine.** Every store is reachable through SQLite with WAL, versioned migrations and a durable event journal, while JSON remains a working fallback. An existing 3.x vault upgrades and rolls back cleanly.
3. **One identity model.** Principals, roles and scoped API keys are enforced on every management route; workspaces isolate data; every sensitive mutation is audited. Existing admin keys migrate without breaking `/v1` inference.
4. **One experience.** The dashboard is event-driven rather than poll-driven, passes accessibility and bundle budgets, and has a coherent V4 shell and design system. Desktop and CLI packaging improve rather than regress.
5. **Release evidence.** `pnpm verify`, `pnpm audit`, e2e, visual, load, migration and security checks pass for the final `4.0.0`, and the tag, GitHub release and npm version all resolve.

**Baseline:** `3.100.2`, 2026-11-25. The plan that delivers this is [v4-platform-plan.md](./v4-platform-plan.md).