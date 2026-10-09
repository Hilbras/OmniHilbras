import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalUsageStore } from '../dist/index.js';

const base = { at: '2026-10-10T12:00:00.000Z', model: 'm', outcome: 'success', attempts: 2, latencyMs: 40 };

function storeWith(records) {
  const directory = mkdtempSync(join(tmpdir(), 'omnihilbras-path-'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'usage.json'), JSON.stringify({ version: 1, records }));
  return new LocalUsageStore({ directory });
}

test('a record written before attempt paths existed still loads, without a path', async () => {
  const store = storeWith([{ id: 'u1', ...base, providerId: 'openrouter' }]);
  const [record] = await store.list();
  assert.equal(record.id, 'u1');
  assert.equal(record.path, undefined, 'an old record shows only its total, not an invented path');
});

test('a record with a request id and an ordered path keeps both on read', async () => {
  const path = [
    { connectionId: 'a', providerId: 'openrouter', dispatched: true, outcome: 'failure', errorCode: 'RATE_LIMITED' },
    { connectionId: 'b', providerId: 'cline', dispatched: true, outcome: 'success' },
  ];
  const store = storeWith([{ id: 'u2', ...base, requestId: 'req_123', path }]);
  const [record] = await store.list();
  assert.equal(record.requestId, 'req_123');
  assert.deepEqual(record.path, path, 'the failover is visible, in order, with each outcome');
});

test('an abandoned or never-dispatched attempt is recorded as such, not as a provider call', async () => {
  const path = [
    { connectionId: 'a', dispatched: true, outcome: 'success' },
    { connectionId: 'b', dispatched: false, outcome: 'abandoned' },
  ];
  const store = storeWith([{ id: 'u3', ...base, requestId: 'req_9', path }]);
  const [record] = await store.list();
  assert.equal(record.path[1].dispatched, false, 'a hedge that never started is not a dispatched call');
  assert.equal(record.path[1].outcome, 'abandoned');
});

test('a malformed path drops the whole record rather than showing a partial failover', async () => {
  const store = storeWith([
    { id: 'good', ...base },
    { id: 'bad', ...base, path: [{ dispatched: 'yes', outcome: 'success' }] },
  ]);
  const ids = (await store.list()).map((record) => record.id);
  assert.deepEqual(ids, ['good'], 'a path with a non-boolean dispatched flag is not a valid record');
});
