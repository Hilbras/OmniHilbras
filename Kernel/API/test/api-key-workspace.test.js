import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalApiKeyStore, InMemoryApiKeyStore } from '../dist/src/core/api-keys.js';

// Phase 9 multi-user foundation: a key may carry a workspace scope. It is optional (single-operator default),
// must be a safe identifier, and must survive a store reopen exactly like every other declared field — the
// rule the credential round-trip test enforces for the vault.

function okWorkspace(id) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id);
}

test('workspace ids are validated before reaching the store', () => {
  assert.equal(okWorkspace('team-alpha'), true);
  assert.equal(okWorkspace('Team_1.2'), true);
  assert.equal(okWorkspace('../etc'), false);
  assert.equal(okWorkspace('a b'), false);
  assert.equal(okWorkspace(''), false);
});

test('workspaceId on a key survives a store reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-key-ws-'));
  try {
    const store = new LocalApiKeyStore({ directory: dir });
    const scoped = await store.create('scoped', 'team-alpha');
    const plain = await store.create('plain');
    assert.equal(scoped.record.workspaceId, 'team-alpha');
    assert.equal(plain.record.workspaceId, undefined, 'absent stays absent — single-operator default');

    const reopened = new LocalApiKeyStore({ directory: dir });
    const list = await reopened.list();
    const found = list.find((entry) => entry.id === scoped.record.id);
    const foundPlain = list.find((entry) => entry.id === plain.record.id);
    assert.equal(found?.workspaceId, 'team-alpha', 'the scope survives a restart');
    assert.equal(foundPlain?.workspaceId, undefined);
    assert.equal((await reopened.authenticate(scoped.key))?.workspaceId, 'team-alpha', 'authentication resolves the scope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in-memory and file-backed stores agree on scope metadata', async () => {
  const memory = new InMemoryApiKeyStore();
  const created = await memory.create('scoped', 'team-alpha');
  assert.equal(created.record.workspaceId, 'team-alpha');
  assert.equal((await memory.authenticate(created.key))?.workspaceId, 'team-alpha');
});
