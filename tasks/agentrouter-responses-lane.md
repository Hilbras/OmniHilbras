# AgentRouter Responses lane — 3.93.3

## The report

`gpt-6.1-sol` answered `/v1/chat/completions` with the relay's own sentence: the model does not support
that endpoint and must be asked through `/v1/responses`. The gateway already had a measured lane for
AgentRouter (`Kernel/API/src/core/provider-responses-lane.ts`) and the SDK already switched a model to it
after the refusal — but only when the adapter had a `responsesPath`.

## Root cause

The gateway's dedicated `AgentrouterAdapter` factory supplied identity headers and the transport, but not
the Responses path. `providerResponsesPath('agentrouter')` was applied only to generic adapters built by
`ProviderResolver`, so `rememberLaneOnRefusal` returned `false` and the refusal was thrown straight to the
caller. The adapter class now accepts `responsesPath`, and the gateway passes the measured value into it.

## Verification

- `Kernel/SDK/tests/responses-lane.test.js` drives the dedicated adapter with the user's exact refusal
  wording, including the Chinese half, and asserts both URLs and the answer from `/responses`.
- `tests/agentrouter-lane.test.js` resolves `agentrouter` through the real `GatewayService` and asserts its
  adapter carries `/responses`, so a factory regression fails even if the SDK test stays green.
- `pnpm verify` and the full unit suite pass. No live AgentRouter request was made.
