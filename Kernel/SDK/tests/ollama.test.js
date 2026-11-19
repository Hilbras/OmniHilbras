import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaAdapter } from '../ollama/dist/adapter/index.js';

/**
 * Ollama's card says `No key`, and the adapter has to mean it.
 *
 * Measured before this test: `listModels({ credential: { type: 'none' } })` threw
 * `AUTHENTICATION_FAILED` from the inherited generic adapter, so the only keyless provider could not
 * be saved with the credential its own card requires. A pasted key still works for a proxied Ollama.
 */

function transport() {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return { status: 200, headers: new Headers(), data: { data: [{ id: 'llama3.2', owned_by: 'library' }] } };
    },
    async *stream() { /* unused */ },
  };
}

test('a keyless Ollama lists models without an Authorization header', async () => {
  const http = transport();
  const adapter = new OllamaAdapter({ transport: http });
  const models = await adapter.listModels({ credential: { type: 'none' } });
  assert.deepEqual(models.map((model) => model.id), ['llama3.2']);
  assert.equal(http.calls[0].headers?.Authorization, undefined, 'a keyless request sent an authorization header');
});

test('a proxied Ollama still sends a pasted key', async () => {
  const http = transport();
  const adapter = new OllamaAdapter({ transport: http });
  await adapter.listModels({ credential: { type: 'api-key', value: 'local-key' } });
  assert.equal(http.calls[0].headers?.Authorization, 'Bearer local-key');
});

test('the saved endpoint is the one Ollama uses', async () => {
  const http = transport();
  const adapter = new OllamaAdapter({ transport: http, endpoint: 'http://127.0.0.1:11435/v1' });
  await adapter.listModels({ credential: { type: 'none' } });
  assert.equal(http.calls[0].url, 'http://127.0.0.1:11435/v1/models');
});
