# @omnihilbras/token-saver

A standalone, provider-agnostic context compressor. It sits beside the gateway, not inside any SDK:
give it a conversation, get a smaller one plus a report of what was removed and how to get it back.

The design is inspired by [Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0):
content routing, JSON/log/text reduction, reversible markers. None of its code or ML model is used here;
the compressors are local, deterministic TypeScript.

## API

```ts
import { compressMessages, MemoryCcrStore, retrieve } from '@omnihilbras/token-saver';

const store = new MemoryCcrStore(200);
const result = compressMessages(messages, { protectRecent: 4, ccr: store });

result.value;              // messages to send
result.stats.savedTokens;  // estimate, not provider billing
result.stats.routes;       // which compressor touched which content

const id = /token-saver:([a-f0-9]+)/.exec(result.value[1].content)?.[1];
retrieve(store, id);       // the original
```

## What it does

| Content | Strategy | Invariant |
| --- | --- | --- |
| JSON | Recursive tree walk, row dedupe, error-row retention, head/tail strings, drop sentinel | Output parses as JSON; error rows survive |
| Logs/build output | Level classification, conservative dedupe, error context, collapsed runs | FATAL/ERROR and their stack context survive |
| Prose | Query/position relevance over whole paragraphs | Code fences, headings, URLs and errors are protected |
| Search output | Whole-paragraph selection with the same relevance fallback | File/line lines stay intact |
| Code | Opt-in line reduction, signatures/imports/control flow protected | Off by default; bodies are not silently deleted |

Every lossy rewrite stores the original in a bounded CCR store and emits
`<<token-saver:<id> N chars elided; retrieve with this id>>`.

Defaults are for a coding agent: system/tool/assistant content may be compressed, user instructions may
not, and the last four turns are untouched. A rewrite that is not smaller is discarded, never reported as
a saving.

## Why this is standalone

The saver knows nothing about providers, HTTP, Electron or the dashboard. That makes it testable in
isolation and lets the gateway, the desktop app, or an SDK adopt it without moving the gateway's routing
logic into a library. Gateway integration is a later, explicit opt-in.

## Limits

- `estimateTokens` is a bytes/4 estimate, not a provider tokenizer. Stats say "estimate" because claiming
  exact token counts without the provider's tokenizer would be a lie.
- The ML prose compressor from Headroom is not ported. The text compressor is lexical, not semantic.
- The CCR store is in-memory by default. Production wiring should back it with a bounded local store.
- Code compression is conservative and opt-in; it will not match an AST compressor.
