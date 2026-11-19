import assert from 'node:assert/strict';
import test from 'node:test';
import { OneHundredMillionSeekAdapter } from '../100milionseek/dist/adapter/index.js';

/**
 * 100milionseek is one OpenAI-compatible endpoint with one model and a Bearer key.
 *
 * The live service was overloaded when this was added, so the wire is asserted against a scripted
 * transport; the card and registry say the same base URL, and a live check is recorded separately
 * when a key can be obtained.
 */

function transport(overrides = {}) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return overrides.request ? overrides.request(request) : { status: 200, headers: new Headers(), data: { data: [{ id: 'deepseek-v4.1-flash-free', owned_by: '100milionseek' }] } };
    },
    async *stream() { /* unused */ },
  };
}

test('the model catalog is read from the provider with the bearer key', async () => {
  const http = transport();
  const models = await new OneHundredMillionSeekAdapter({ transport: http }).listModels({ credential: { type: 'api-key', value: 'hms-test' } });
  assert.deepEqual(models.map((model) => model.id), ['deepseek-v4.1-flash-free']);
  assert.equal(http.calls[0].url, 'https://100milionseek.top/v1/models');
  assert.equal(http.calls[0].headers?.Authorization, 'Bearer hms-test');
});

test('a chat request keeps the model id the provider published', async () => {
  const http = transport({
    request: async () => ({
      status: 200,
      headers: new Headers(),
      data: { id: 'r', model: 'deepseek-v4.1-flash-free', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
    }),
  });
  const response = await new OneHundredMillionSeekAdapter({ transport: http }).chat(
    { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] },
    { credential: { type: 'api-key', value: 'hms-test' } },
  );
  assert.equal(response.model, 'deepseek-v4.1-flash-free');
  assert.ok(http.calls[0].body?.includes('deepseek-v4.1-flash-free') === true);
});
