import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { LocalWebhookStore, WebhookDispatcher, verifyWebhookSignature, webhookDestinationAllowed } from '../dist/src/core/webhooks.js';

test('only https public destinations are allowed unless the operator opts in', () => {
  assert.equal(webhookDestinationAllowed('https://example.com/hook').allowed, true);
  assert.equal(webhookDestinationAllowed('http://example.com/hook').allowed, false);
  assert.equal(webhookDestinationAllowed('https://127.0.0.1/hook').allowed, false);
  assert.equal(webhookDestinationAllowed('https://127.0.0.1/hook', true).allowed, true);
});

test('the signature covers the timestamp and the body', () => {
  const signature = createHmac('sha256', 'secret').update('123.body').digest('hex');
  assert.equal(verifyWebhookSignature('secret', '123', 'body', signature), true);
  assert.equal(verifyWebhookSignature('secret', '124', 'body', signature), false);
  assert.equal(verifyWebhookSignature('other', '123', 'body', signature), false);
});

test('a delivery retries a failure and signs every attempt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-hooks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalWebhookStore({ directory });
  const hook = await store.save({ url: 'https://example.com/hook', events: ['test'], allowLocal: true });
  const attempts = [];
  const dispatcher = new WebhookDispatcher({
    store, allowLocal: true, attempts: 3, retryDelayMs: 1,
    fetchImpl: async (url, init) => {
      attempts.push({ url, headers: init.headers, body: init.body });
      return new Response('', { status: attempts.length === 1 ? 500 : 200 });
    },
  });
  const results = await dispatcher.deliver('test', { ok: true });
  assert.equal(attempts.length, 2, 'a 500 was not retried exactly once');
  assert.equal(results[0].status, 'delivered');
  const headers = attempts[0].headers;
  assert.ok(verifyWebhookSignature(hook.secret, headers['x-omnihilbras-timestamp'], attempts[0].body, headers['x-omnihilbras-signature'].replace('sha256=', '')));
});

test('a hook is not sent an event it did not subscribe to', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-hooks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalWebhookStore({ directory });
  await store.save({ url: 'https://example.com/hook', events: ['batch.completed'], allowLocal: true });
  let called = 0;
  const dispatcher = new WebhookDispatcher({ store, allowLocal: true, fetchImpl: async () => { called += 1; return new Response('', { status: 200 }); } });
  await dispatcher.deliver('test', {});
  assert.equal(called, 0);
});
