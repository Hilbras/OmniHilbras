import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemoryVirtualModelStore,
  LocalVirtualModelStore,
  normalizeVirtualModelInput,
} from '../dist/src/core/index.js';

/** Every virtual ID is an `oh/` ID; targets are structural, connection existence is checked at the API edge. */

const target = (connectionId = 'conn-a', upstreamModelId = 'gpt-4o') => ({ connectionId, upstreamModelId });

test('a virtual model id must start with oh/', () => {
  assert.throws(() => normalizeVirtualModelInput({ id: 'gpt-4o', targets: [target()] }), /start with "oh\/"/);
  assert.throws(() => normalizeVirtualModelInput({ id: 'oh/', targets: [target()] }), /start with "oh\/"/);
  assert.equal(normalizeVirtualModelInput({ id: 'oh/chat', targets: [target()] }).id, 'oh/chat');
});

test('an enabled model needs at least one enabled target, a disabled draft does not', () => {
  assert.throws(() => normalizeVirtualModelInput({ id: 'oh/chat', targets: [] }), /at least one enabled target/);
  assert.throws(() => normalizeVirtualModelInput({ id: 'oh/chat', targets: [{ ...target(), enabled: false }] }), /at least one enabled target/);
  const draft = normalizeVirtualModelInput({ id: 'oh/chat', enabled: false, targets: [] });
  assert.equal(draft.enabled, false);
  assert.deepEqual(draft.targets, []);
});

test('targets cannot repeat a connection and upstream model', () => {
  assert.throws(
    () => normalizeVirtualModelInput({ id: 'oh/chat', targets: [target(), target()] }),
    /same connection and upstream model twice/,
  );
});

test('the store persists across a restart, including a disabled draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-virtual-'));
  try {
    const first = new LocalVirtualModelStore({ directory });
    await first.save({ id: 'oh/chat', name: 'Chat', strategy: 'round-robin', targets: [target()] });
    await first.save({ id: 'oh/draft', enabled: false, targets: [] });

    const second = new LocalVirtualModelStore({ directory });
    const listed = await second.list();
    assert.deepEqual(listed.map((model) => model.id), ['oh/chat', 'oh/draft']);
    assert.equal(listed[0].strategy, 'round-robin');
    assert.equal(listed[1].enabled, false);
    assert.match(await readFile(join(directory, 'virtual-models.json'), 'utf8'), /"oh\/chat"/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('one malformed stored record does not hide the others', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-virtual-bad-'));
  try {
    await writeFile(join(directory, 'virtual-models.json'), JSON.stringify({
      version: 1,
      models: [
        { id: 'not-virtual', targets: [target()] },
        { id: 'oh/good', name: 'Good', enabled: true, strategy: 'priority', targets: [{ ...target(), priority: 1, enabled: true }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    }));
    const store = new LocalVirtualModelStore({ directory });
    assert.deepEqual((await store.list()).map((model) => model.id), ['oh/good']);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('the in-memory store replaces a record instead of duplicating its id', async () => {
  const store = new InMemoryVirtualModelStore();
  await store.save({ id: 'oh/chat', name: 'First', targets: [target()] });
  await store.save({ id: 'oh/chat', name: 'Second', targets: [target('conn-b', 'claude-sonnet')] });
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Second');
  assert.equal(await store.remove('oh/chat'), true);
  assert.equal(await store.remove('oh/chat'), false);
});
