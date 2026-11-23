# Stated tool-contract mismatch — 3.95.0

## Why

Continuing a conversation after switching providers ended silently: the new provider could not serve
the client's tool definitions, `normalizeToolsRequest()` stripped them with a console-only note, and
the model returned a normal text turn. The agent saw `finish_reason: stop` with no call to execute and
stopped. The usage log recorded `success`, so the halt left no evidence.

## What changed

- `applyToolContract()` refuses with `NOT_SUPPORTED` when a client declared tools that the target
  provider — or one of its models — cannot serve. The refusal happens before dispatch, so no provider
  is billed and the stream route answers with a JSON error rather than a truncated SSE body.
  `tool_choice: 'none'` and requests without tools are unaffected.
- The same pass records counts (`declared`, `forwarded`, `stripped`, `dropped`) on the request and
  writes them to the usage record. They are numbers only — no tool name or schema reaches storage.
  The Logs page labels and finds records whose tools were stripped or dropped.
- Two bugs found while testing: `normalizeModelMeta()` discarded provider-stated `false` capability
  flags (making per-model narrowing unreachable after a save), and `attachAttempts()` dropped a
  terminal error's `publicMessage` after failover (reducing the refusal to a generic sentence). Both
  are fixed.

## Verification

`pnpm verify`, full unit suite, `tests/e2e/tool-mismatch.spec.ts` with a stubbed usage record, and
`pnpm release:audit`. No live provider call and no tokens spent.
