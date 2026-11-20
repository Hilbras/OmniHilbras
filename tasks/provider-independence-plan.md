# Provider independence plan — every id owns its config, package and route surface

Goal: for every catalog provider id, the provider is a first-class citizen the way `opencode-go` is: its own registry
config (base URL, lanes/formats, model catalog, usage endpoint, auth), its own SDK package, and its own gateway route
surface (with OAuth only where a real sign-in flow exists). No provider id may be an anonymous instance of a generic
adapter with all its facts living in a dashboard card.

Scope: 57 catalog ids in `src/data/providers.ts`. 29 SDK packages already exist; ~25 ids are currently only generic
OpenAI-compatible connections. OAuth routes already exist for the providers with real flows; API-key providers get a
connection-save surface, not an invented OAuth flow.

## Phase 1 — Registry foundation

- [x] One row per catalog id in `Kernel/Tools/src/providerRegistry.ts` (57 rows: id, name, baseUrl, modelsUrl,
      auth, formats, optional usageUrl).
- [x] `tests/provider-registry.test.js` fails if a card has no row or a row has no card.
- [x] `ProviderResolver` uses the registry base when a saved connection has no endpoint, while a custom endpoint
      still wins.
- [x] Verify: `pnpm verify` passed before phase 2 began.

## Phase 2 — SDK package per id

- [x] Generated 24 packages for ids that had none: agnes-ai, agentrouter, aion-labs, numes, kiraai, vengetic,
      anyrouter, zro, unorouter, ollama, mistral, nara-router, tokenharbor, apinex, tiarina, xkiro, kimi, deepseek,
      qwen, qwen-token-plan, groq, grok, nvidia, coarena. Each declares its own id/base from the registry, carries
      vendored `types.ts`/`errors.ts`, is private at `0.1.0`, and is built/cleaned with the rest of the SDK.
- [x] Gateway registers every one with an explicit `.onDemand('id', …)` so the id is readable to the guards.
- [x] AgentRouter's client identity and Ollama's keyless validation moved into their own packages.
- [x] Guards updated for the new counts and the new rule (a card sharing an id with its own adapter is correct).
- [ ] Verify: running; the last full pass was green before the final resolver-order fix.

## Phase 3 — Gateway registration and routes

- [x] One explicit `.onDemand('<id>', …)` registration per new id, resolving that id's own package.
- [x] `ProviderResolver` uses the registry base as the default; a saved connection may override it with a custom endpoint.
- [x] A guard checks every OAuth provider has its own start/session route, or names the connection owner it signs in
      through (`clinepass` → `cline`); every OAuth route names a registry row.
- [x] Verify: `pnpm verify` and `pnpm test:e2e` pass.

## Phase 4 — Docs and release

- [x] SPEC gets a provider-independence section; README states the rule.
- [x] Version `3.69.0`, tag on `main`, GitHub release, npm publish confirmed with `npm view`, release audit clean.
- [x] CI on `v3.69.0`: verify, e2e, Docker and desktop all green.
