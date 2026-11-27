# Migrating to 4.9.1

4.9.1 fixes three provider **checks**. Inference behavior is unchanged; a provider that worked before still
works the same way, and one that was reported incorrectly is reported correctly now.

## NVIDIA Check no longer fails a valid key

NVIDIA's `/v1/models` is public, so the only honest key check is a real inference request. That request used
the **first catalog entry**, and on 2026-11-27 the first entry was `bigcode/starcoder2-15b`, which answered
`404 page not found` when posted to `/completions`. The Check button then said "NVIDIA answered 404" for a key
that a real turn through `nvidia/nemotron-3.5-super-vl-120b-a12b` had just used successfully (HTTP 200, 541 ms).

The probe now tries up to five catalog models — those with chat-shaped metadata first, then the rest — and
treats `400`/`404`/`422` as a statement about that model, moving on. `401`/`403` still means the key was
refused, and a key that is refused is not retried against every model.

## Codex Check actually asks the provider

`validateCredential` used to return `valid` from the OAuth token's shape alone. A revoked or expired token
passed Check because nothing was sent. It now performs the same free, authenticated catalog read that the
health check uses, and reports the measured latency.

## ZCode surfaces the provider's business error

ZCode can answer `200` with a business envelope instead of an Anthropic message. The adapter already surfaced
`{code, msg}`; the backend has also answered `{code, message}`, which was reported as **"the provider returned
an invalid response"** with no reason. Both spellings and the code are now included, so Check says what ZCode
actually refused (for example a token or quota message) instead of hiding it.

## What to expect after upgrading

- Restart the gateway so the new adapters load.
- Re-run Check on NVIDIA, Codex and ZCode. NVIDIA should pass for a key that can serve a chat; Codex will take
  one catalog round trip; ZCode will either pass or name the provider's refusal.
- A provider with no entitlement (for example a Qoder account with no active plan) can still pass a catalog
  check and fail a real turn. That is an account state, not a credential failure, and the real-turn error is
  the one that names it.
