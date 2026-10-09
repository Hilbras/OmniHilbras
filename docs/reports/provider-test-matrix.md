# Provider test matrix

Phase 3.1 evidence. Every cell is measured from the test files at commit `40de03b`, by keyword search over each
adapter's tests, followed by a read of the shared tests that cover several adapters at once. A keyword hit is a
lead, not proof, so the notes column records what was actually confirmed.

Legend: **y** the adapter's own tests cover it · **shared** covered once for all adapters by the transport tests ·
**-** no adapter-level coverage found.

| Adapter | Test files | Streaming | Auth error | Rate limit | Tool calls | Timeout / abort | Fixture |
| --- | --- | --- | --- | --- | --- | --- | --- |
| anthropic | anthropic.test.js | y | y | shared | y | shared | hand-written frames |
| chatgpt-web | chatgpt-web.test.js | y | y | y | - | shared | browser DOM, none |
| claude-code | claude-code.test.js | y | y | shared | y | shared | none |
| cline | cline.test.js, clinepass.test.js | y | y | y | - | shared | cline-models.json |
| clinepass | clinepass.test.js | y | y | shared | - | shared | shares cline's wire format |
| deepseek-web | deepseek-web.test.js | y | y | shared | - | shared | hand-written frames |
| gemini | gemini.test.js | y | y | shared | y | shared | hand-written frames |
| kimi-code | kimi-code.test.js | y | y | shared | y | shared | none |
| kiro | kiro.test.js | y | y | shared | - | shared | kiro-stream.bin |
| openai | openai.test.js | y | y | shared | - | shared | none |
| opencode-console | opencode-console.test.js | y | y | shared | y | shared | opencode-console-models.json |
| openrouter | openrouter.test.js | y | y | shared | - | shared | openrouter-models.json |
| tokenharbor-web | tokenharbor-web.test.js | y | y | shared | - | shared | none |
| zen | zen.test.js, zen-free-tier.test.js | y | y | shared | y | shared | zen-models.json (listing shape) |

## What the matrix shows

- **Rate limiting is covered once, not per adapter.** `status-mapping.test.js` asserts that a 429 maps to
  `RATE_LIMITED` and is retryable, for every adapter that goes through the shared transport. Only ChatGPT Web and
  Cline assert it in their own files.
- **Timeouts are covered once, not per adapter.** `stream-bounds.test.js` and `core.test.js` cover the transport's
  timeout and abort. No adapter asserts its own timeout behaviour.
- **Tool calls are asserted by six adapters** (anthropic, claude-code, gemini, kimi-code, opencode-console, zen). The
  rest have no tool-call test, which is correct for providers that do not expose tools on their path.
- **Fixtures are real for four adapters only** (openrouter, cline, opencode-console, zen listing shape) plus the
  binary kiro stream. Every other adapter's frames are hand-written in its test file, which the fixture guard
  records as a known gap, not a hidden one.

## Phase 3 status against the roadmap

| Item | Status |
| --- | --- |
| 3.1 Test matrix | **done** (this file) |
| 3.2 Realistic fixtures: successful non-streaming | partial: openrouter and cline listings, zen listing shape |
| 3.2 Realistic fixtures: successful streaming | partial: kiro binary stream only |
| 3.2 Realistic fixtures: empty, provider error, auth, rate limit, timeout | **missing for every adapter** (needs live credentials for most) |
| 3.2 Usage metadata, tool-call, malformed bodies | missing |
| 3.3 Contract vs fixture tests kept separate | done (existing: `provider-contract` and `fixture-coverage`) |
| 3.4 Silent-gap prevention | done (existing `fixture-coverage` guard, counts in sync) |

## Blocked, and why

Most of the missing 3.2 rows need a real response from a provider that answers only with a credential this machine
does not have. Those captures cannot be made here, and inventing them is the failure the fixture guard exists to
prevent. They stay open until credentials are supplied.

Without a key, the public listings that do answer are already captured (OpenRouter, Zen, xKiro). Authenticated
streaming, provider errors and tool calls are not.

## Closed since the matrix was first written

- **DeepSeek Web and TokenHarbor Web status branches** were not covered by their own tests. They map their own
  status codes instead of using the shared transport. `packages/omnihilbras-sdk/test/web-session-refusals.test.js`
  now drives those branches: 429 is a retryable rate limit; 401 and 403 are authentication failures, with the
  re-export or re-paste instruction; an unknown status is unavailable with the status in the message; TokenHarbor's
  402 names the missing balance and says `:free` models do not bill; 5xx is retryable and other 4xx are not; an
  expired session is named as expired. The test uses a well-formed `base64-` session, because the parser correctly
  refuses a truncated one.
