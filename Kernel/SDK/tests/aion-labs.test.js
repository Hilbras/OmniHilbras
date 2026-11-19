import assert from 'node:assert/strict';
import test from 'node:test';
import { AionLabsAdapter } from '../aion-labs/dist/adapter/index.js';

/**
 * Aion's catalog is public, so a catalog read cannot prove a key. The adapter's validation is a real
 * one-token completion after the catalog read; these tests drive that path with a scripted transport.
 */
function transport() {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      if (request.url.endsWith('/models')) {
        return { status: 200, headers: new Headers(), data: { data: [{ id: 'aion-labs/aion-2.0', context_length: 131072 }] } };
      }
      return {
        status: 200,
        headers: new Headers(),
        data: { id: 'r', model: 'aion-labs/aion-2.0', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
      };
    },
    async *stream() { /* unused */ },
  };
}

test('validation is a real authenticated turn, not the public catalog', async () => {
  const http = transport();
  const result = await new AionLabsAdapter({ transport: http }).validateCredential(
    { type: 'api-key', value: 'aion-key' },
  );
  assert.equal(result.status, 'valid');
  assert.equal(http.calls.length, 2, 'the catalog alone was treated as a check');
  assert.match(http.calls[1].url, /chat\/completions$/);
  assert.equal(http.calls[1].headers?.Authorization, 'Bearer aion-key');
  assert.ok(http.calls[1].body?.includes('"max_tokens":1') || http.calls[1].body?.includes('"max_completion_tokens":1'));
});

test('a missing key is refused before any request', async () => {
  const http = transport();
  await assert.rejects(
    () => new AionLabsAdapter({ transport: http }).validateCredential({ type: 'none' }),
    /API key is required/,
  );
  assert.equal(http.calls.length, 0);
});
