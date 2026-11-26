import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBatchStore, parseBatchItems } from '../dist/src/core/batches.js';

test('the batch body refuses a duplicate id and a body that cannot be a chat request', () => {
  assert.match(parseBatchItems([{ custom_id: 'a', body: { model: 'm', messages: [] } }, { custom_id: 'a', body: { model: 'm', messages: [] } }]).error ?? '', /Duplicate/);
  assert.match(parseBatchItems([{ custom_id: 'a', body: { model: 'm' } }]).error ?? '', /model and messages/);
  assert.equal(parseBatchItems([{ custom_id: 'a', body: { model: 'm', messages: [] } }]).items.length, 1);
});

test('an interrupted batch is marked rather than pretending it finished', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-batches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new LocalBatchStore({ directory });
  const batch = await first.create({ status: 'in_progress', items: [{ customId: 'a', body: {} }], results: [] });
  const reopened = new LocalBatchStore({ directory });
  const read = await reopened.get(batch.id);
  assert.equal(read.status, 'interrupted');
  assert.match(read.error ?? '', /restarted/);
});
