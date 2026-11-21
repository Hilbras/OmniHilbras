# Model identity and per-model capability — phase 2 (3.92.0)

## Why

Two failure modes shared a root: the gateway treated a public model id as the wire id and treated
tool capability as a fact about providers only.

- A rotating or aliased upstream id (`vendor/tier/model`, a `:free` suffix) was frozen in the saved
  catalog, with no place to record that the wire wanted a different spelling. ClinePass worked only
  because its adapter stripped and re-added its own tier prefix by hand.
- A provider that serves tools was assumed to serve them on every one of its models. NVIDIA now
  publishes `supports_tools` per model, but the gateway never consulted it, so a model that cannot
  call tools was advertised with them and failed only after a turn was paid for.
- An unknown `vendor/model` id that no connection listed was dispatched to **every** usable
  connection — measured at 9–90 s and several paid calls before a refusal.

## What changed

- `Model.upstreamModelId` is stored as `ModelMeta.u`, restored on `/v1/models`, and used at dispatch
  when explicitly present. ClinePass declares it; an absent field changes nothing.
- `narrowedToolCaps()` in `Kernel/API/src/core/modelCapabilities.ts` looks up the full namespaced id
  first, then the stripped id and spelling variants, using metadata already in `modelMeta`. It can
  only narrow: a catalog never grants tools to a provider whose row refuses them.
- `normalizeToolsRequest()` accepts an optional capability override, so the narrowing happens in the
  one place where tool requests are sanitised rather than in a second copy of that logic.
- `resolveRoute()` refuses an unowned namespaced id instead of fanning out. Bare ids keep the
  documented all-connection fallback.

## Verification

`pnpm verify`. New guards: `Kernel/API/test/model-capabilities.test.js`, an upstream-id round trip in
`model-meta-round-trip.test.js`, a namespaced refusal in `routing-engine.test.js` and `api-keys.test.js`.
No live provider calls; the tool-override path is exercised with scripted transports.

## Not done here

Phases 3–4: a canonical tool-name map and scoped failure classification with terminal truth.
