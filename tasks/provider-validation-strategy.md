# Provider validation strategy — phase 1 (3.91.0)

## Why

The dashboard's Check button could not succeed for 33 of 54 adapters: the route asked for a
`validateCredential` the adapter did not have and got `501 NOT_SUPPORTED`. Meanwhile the dialog
footer promised that "the key is checked", and "Test account" used a different route whose generic
`listModels` fallback reported a public catalog read as a credential check. NVIDIA was the measured
example of the latter: `/v1/models` answers 200 with no key and with a bogus key.

Separately, only 5 of the 27 own-provider factories passed the gateway's configured transport to
their adapter. The other 22 fell back to the SDK's 30 s default, so a slow reasoning turn could be
cut off before the gateway's 120 s deadline.

## What changed

- `CredentialValidationStrategy` (`credential` | `models` | `none`) is declared on each on-demand
  registration. `none` is a decision, not an absence: the gateway answers with a sentence explaining
  that the sign-in/device flow is the proof, and does not launch a browser to check an unsaved cookie.
- The strategy lives beside the factory in `own-provider-adapters.ts`, so a provider cannot declare
  one check and implement another. Browser-backed web sessions declare `none`; adapters with a real
  validator declare `credential`; `models` requires an explicit evidence entry in the guard test.
- Every own-provider factory now forwards `transport: this.transport`. `tests/provider-validation.test.js`
  asserts both facts against a live `GatewayService` and a scripted transport.
- The Check dialog no longer promises a check for providers that cannot perform one.

## Verification

`pnpm verify` (version, brand, typecheck, tests, SPEC, build, CLI smoke, bundle budget). New guard:
`tests/provider-validation.test.js`. No live provider requests were made; all verification uses the
scripted transport harness.

## Not done here

Phases 2–4 of `docs/reports/comparison-9router-2026-11-20.md`'s structural follow-up: upstream model
ids, per-model capabilities, canonical tool maps, and scoped failure classification.
