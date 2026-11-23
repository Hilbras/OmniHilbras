import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryRequestDetailStore,
  LocalRequestDetailStore,
  parseRequestDetailState,
  sanitizeErrorText,
  sanitizeToolNames,
  sanitizeSchemaBytes,
} from '../dist/src/core/index.js';
import { InMemoryApiKeyStore, InMemoryConnectionStore, GatewayService, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

const FORBIDDEN = ['prompt', 'response', 'messages', 'content', 'text', 'headers', 'apiKey', 'authorization', 'credential', 'body'];

test('a detail record holds only whitelisted, redacted fields', async () => {
  const store = new InMemoryRequestDetailStore();
  const detail = await store.record({
    requestId: 'req_1',
    model: 'gpt-x',
    providerId: 'openai',
    errorText: 'Bearer sk-abcdefghijklmnop refused for ?key=supersecret',
    toolNames: ['lookup', 'lookup', 'search'],
    schemaBytes: { declared: 120, forwarded: 90 },
  });
  assert.match(detail.errorText, /Bearer \[redacted\]/);
  assert.match(detail.errorText, /key=\[redacted\]/);
  assert.doesNotMatch(detail.errorText, /abcdefghijklmnop|supersecret/);
  assert.deepEqual(detail.toolNames, ['lookup', 'search']);
  assert.deepEqual(detail.schemaBytes, { declared: 120, forwarded: 90 });
  for (const key of FORBIDDEN) assert.equal(key in detail, false, `the detail record gained ${key}`);
  assert.deepEqual(await store.list({ requestId: 'req_1' }), [detail]);
});

test('sanitisers bound size and drop non-whitelisted shapes', () => {
  assert.equal(sanitizeErrorText('line1\nline2'), 'line1 line2');
  assert.equal(sanitizeErrorText('x'.repeat(2000)).length, 500);
  assert.equal(sanitizeErrorText(42), undefined);
  assert.deepEqual(sanitizeToolNames(['a'.repeat(200), '', 'ok', 7]), ['a'.repeat(80), 'ok']);
  assert.equal(sanitizeSchemaBytes({ declared: -1, forwarded: 2 }), undefined);
  assert.deepEqual(sanitizeSchemaBytes({ declared: 10.7, forwarded: 2.2 }), { declared: 10, forwarded: 2 });
});

test('a file-backed store is bounded by record count and survives a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oh-details-'));
  const path = join(directory, 'request-details.json');
  const first = new LocalRequestDetailStore({ path, maxRecords: 2 });
  for (let index = 0; index < 5; index += 1) {
    await first.record({ requestId: `req_${index}`, model: 'm', errorText: `error ${index}` });
  }
  assert.deepEqual((await first.list()).map((entry) => entry.requestId), ['req_4', 'req_3']);
  const raw = await readFile(path, 'utf8');
  for (const key of FORBIDDEN) assert.equal(raw.includes(`"${key}"`), false, `the detail file contains ${key}`);
  const reopened = new LocalRequestDetailStore({ path, maxRecords: 2 });
  assert.deepEqual((await reopened.list()).map((entry) => entry.requestId), ['req_4', 'req_3']);
  const files = await readdir(directory);
  assert.ok(files.length <= 2, 'no unbounded sidecar files');
});

test('a backup section round-trips through the strict parser', async () => {
  const source = new InMemoryRequestDetailStore();
  await source.record({ requestId: 'req_backup', model: 'm', providerId: 'p', toolNames: ['t'] });
  const state = await source.exportState();
  const restored = new InMemoryRequestDetailStore();
  await restored.importState(parseRequestDetailState(state));
  assert.deepEqual(await restored.list(), await source.list());
  assert.throws(() => parseRequestDetailState({ version: 1, details: [{ requestId: 3, model: 'm' }] }), /unreadable request detail/);
});

test('the detail route is opt-in and answers with the gateway data only', async (t) => {
  const details = new InMemoryRequestDetailStore();
  await details.record({ requestId: 'req_http', model: 'm', errorText: 'Bearer sk-abcdefghijklmnop' });
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('details')).key;
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { requestDetails: details });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/v1/observability/request-details?requestId=req_http`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(body.data.length, 1);
  assert.match(body.data[0].errorText, /\[redacted\]/);
  for (const key of FORBIDDEN) assert.equal(key in body.data[0], false, `the route exposed ${key}`);
});
