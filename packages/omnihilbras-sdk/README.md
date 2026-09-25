# @omnihilbras/hilbras

Typed provider SDK for the [OmniHilbras](https://github.com/Hilbras/OmniHilbras)
gateway. One normalized contract for chat, streaming, model listing, and
capabilities across OpenAI, Anthropic, Gemini, OpenRouter, and any
OpenAI-compatible endpoint.

```bash
npm i @omnihilbras/hilbras
```

Requires Node.js 20 or newer. Ships ESM only.

## Quick start

```ts
import { AnthropicAdapter, FetchHttpTransport, GeminiAdapter, OpenAIAdapter, ProviderRegistry } from '@omnihilbras/hilbras';

const registry = new ProviderRegistry();
registry.register(new OpenAIAdapter({ baseUrl: 'https://api.openai.com/v1' }));
registry.register(new AnthropicAdapter({ baseUrl: 'https://api.anthropic.com' }));
registry.register(new GeminiAdapter({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }));

const adapter = registry.require('openai');
const response = await adapter.chat(
  { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Hello' }] },
  { credential: { type: 'api-key', value: process.env.OPENAI_API_KEY! } },
);
```

## What you get

- **Normalized types** for `ChatRequest`, `ChatResponse`, `ChatChunk`, and `Model`,
  so application code never branches on provider wire formats.
- **`AsyncIterable` streaming.** Native SSE for each provider is normalized into
  the same chunk stream, and a stream that ends without a terminal finish reason
  is rejected instead of silently truncating.
- **A capability registry.** Adapters declare what they support; the registry
  refuses an adapter that claims a capability it does not implement, and
  `registry.require()` throws a typed error for an unknown provider.
- **One error type.** `ProviderError` carries a code, provider, HTTP status, and
  a `retryable` flag, with a public message that never includes provider response
  bodies or credentials.
- **Transport controls.** Timeouts, cancellation, response and stream size caps,
  no redirect following, and provider URL validation.
- **A credential abstraction.** `SecretStore` keeps provider keys out of your
  call sites.

```ts
for await (const chunk of adapter.streamChat(request, context)) {
  process.stdout.write(chunk.delta.content ?? '');
}
```

## License

MIT. See [LICENSE](https://github.com/Hilbras/OmniHilbras/blob/main/LICENSE).
