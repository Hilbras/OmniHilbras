# Tool contract convergence — phase 3 (3.92.1)

## Why

The tool contract was fixed three times in three releases because the same rule lived in several
layers. The last uncovered drift: the non-streaming response guard restored a caller's casing
(`Read`) via the canonical wire→caller name map, and the stream guard did too, but the gateway's
**local-tool round** called the same guard without the map. A provider that folded `Read` to `read`
returned a call the agent did not recognise — the turn looked complete and the tool never ran.

## What changed

- `runLocalToolRounds` now passes `contracted.renames` to `validatedToolResponse`, the same map the
  direct chat and stream paths use.
- Coverage guard: every SDK adapter package has a caps row in `Kernel/Tools/src/caps.ts` or is a
  named alias (`codebuddy`, `opencode-zen`, `zcode-start-plan`).
- Lane guard: OpenCode Zen's Messages/Responses streaming refuses with `NOT_SUPPORTED` before the
  first chunk and without reaching its transport. This was already the code's behaviour; it is now a
  test, so a future "just answer without a stream" change fails.

## Verification

`pnpm verify`; focused guards in `tests/local-tools.test.js`, `tests/tools-caps.test.js` and
`Kernel/API/test/tool-contract.test.js`. No live provider calls.

## Not done here

Phase 4: scoped failure classification, `Retry-After` and terminal truth in the usage store.
