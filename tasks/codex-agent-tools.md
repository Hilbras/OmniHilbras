# Codex agent tool lifecycle — 3.94.0

## Why

Codex was declared `TOOLS_REFUSED`: `assertSupportedRequest()` threw on tool definitions, tool history,
and `tool_choice`, the request body carried no `tools`, and the stream reader ignored `function_call`
events. The gateway's caps row agreed, so tools were stripped before the adapter and an agent saw a
finished text turn with no call to execute. That is why an agent lifecycle could not form on Codex.

## What changed

- `Kernel/SDK/codex/lib/responses-tools.ts` carries the package-local Responses shapes: flat function
  definitions, `function_call` / `function_call_output` items with `call_id`, and tool deltas by
  `output_index`. It is a Codex-local copy because a provider package may not import another SDK's
  vendored machinery.
- The adapter now sends `tools` and `tool_choice`, accepts a replayed tool round, emits assembled tool
  calls from `chat()` (arguments joined by index), and ends a tool-only turn with
  `finish_reason: tool_calls` rather than reporting an empty answer.
- Forced choice is refused by name: `Kernel/Tools/src/caps.ts` moves `codex` to the no-forcing group.
  Backend support for forcing has not been measured, so the gateway does not claim it.
- Tests: `Kernel/SDK/tests/codex.test.js` drives a full tool round and a tool-only turn;
  `tests/tools-behaviour.test.js` asserts the flat wire body and the forced-choice refusal;
  `Kernel/Tools/test/tools.test.js` pins the new caps row.

## Verification

`pnpm verify` and the full unit suite pass. All tool shapes are exercised with scripted transports and
OpenAI's documented Responses frames. **No live Codex credential was available**, so the backend's
acceptance of function tools and of `tool_choice: 'auto' | 'none'` remains unverified against the real
service; the first live agent turn is the proof.
