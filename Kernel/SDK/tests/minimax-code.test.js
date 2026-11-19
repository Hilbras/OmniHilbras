import assert from 'node:assert/strict';
import test from 'node:test';
import { createMinimaxCodeAdapter } from '../minimax-code/dist/adapter/index.js';

/**
 * MiniMax Code's catalog, in the shape it actually answers with.
 *
 * Measured 2026-11-19 from a signed-in account:
 *
 * ```json
 * { "version": "...", "ttlSeconds": 3600, "providers": [
 *   { "providerId": "minimax", "config": {
 *     "models": { "MiniMax-M3": { "name": "M3", "limit": { "context": 512000 } } },
 *     "model_order": ["MiniMax-M3", "MiniMax-M3.1-Flash"],
 *     "whitelist": ["MiniMax-M3", "MiniMax-M3.1-Flash"]
 *   } }
 * ] }
 * ```
 *
 * The adapter required `{ data: [{ id, name }] }`, so the sign-in completed and saved a connection with
 * zero models, and the health check reported "unreadable model catalog". A parser that rejects a shape it
 * has not seen is right; a parser that has not been taught the live shape turns a healthy account into a
 * broken card.
 */

function transport(body) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return { status: 200, headers: new Headers(), data: body };
    },
    async *stream() { /* unused */ },
  };
}

const credential = { type: 'oauth', value: 'access-token' };

test('the live providers/config/models shape is read, with order, names and context', async () => {
  const http = transport({
    version: '2026-11-19',
    ttlSeconds: 3600,
    providers: [
      {
        providerId: 'minimax',
        config: {
          // Deliberately not alphabetical: `model_order` is what MiniMax's own client shows.
          models: {
            'MiniMax-M3.1-Flash': { name: 'M3.1-Flash', limit: { context: 512000 } },
            'MiniMax-M3': { name: 'M3', limit: { context: 512000 } },
          },
          model_order: ['MiniMax-M3', 'MiniMax-M3.1-Flash'],
          whitelist: ['MiniMax-M3', 'MiniMax-M3.1-Flash'],
        },
      },
    ],
  });
  const adapter = createMinimaxCodeAdapter('global', { transport: http });
  const models = await adapter.listModels({ credential });

  assert.deepEqual(models.map((model) => model.id), ['MiniMax-M3', 'MiniMax-M3.1-Flash']);
  assert.equal(models[0].displayName, 'M3');
  assert.equal(models[0].contextWindow, 512000);
  assert.equal(models[0].providerId, 'minimax-code-global');
  assert.equal(http.calls[0].headers.Authorization, 'Bearer access-token');
});

test('a non-empty whitelist is the account entitlement, and it gates the table', async () => {
  const http = transport({
    providers: [{
      config: {
        models: {
          'MiniMax-M3': { name: 'M3' },
          'MiniMax-M3.1-Flash': { name: 'M3.1-Flash' },
        },
        model_order: ['MiniMax-M3', 'MiniMax-M3.1-Flash'],
        whitelist: ['MiniMax-M3'],
      },
    }],
  });
  const adapter = createMinimaxCodeAdapter('global', { transport: http });
  const models = await adapter.listModels({ credential });
  assert.deepEqual(models.map((model) => model.id), ['MiniMax-M3'], 'a listed-but-not-entitled model must not be advertised');
});

test('the legacy data array is still accepted', async () => {
  const http = transport({ data: [{ id: 'MiniMax-M2', name: 'M2' }] });
  const adapter = createMinimaxCodeAdapter('cn', { transport: http });
  const models = await adapter.listModels({ credential });
  assert.deepEqual(models.map((model) => model.id), ['MiniMax-M2']);
  assert.equal(models[0].displayName, 'M2');
});

test('a recognised shape with no models is empty, not unreadable', async () => {
  const http = transport({ providers: [{ providerId: 'minimax', config: { models: {}, model_order: [], whitelist: [] } }] });
  const adapter = createMinimaxCodeAdapter('global', { transport: http });
  assert.deepEqual(await adapter.listModels({ credential }), []);
});

test('an unrecognised shape is still refused, not guessed', async () => {
  const http = transport({ items: [] });
  const adapter = createMinimaxCodeAdapter('global', { transport: http });
  await assert.rejects(adapter.listModels({ credential }), /unreadable model catalog/i);
});
