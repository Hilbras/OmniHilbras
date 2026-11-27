import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPromptStore, parsePromptState, promptVariables, renderPrompt } from '../dist/src/core/prompts.js';
import { GatewayService, InMemoryConnectionStore } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { decryptBackup } from '../dist/src/core/backup.js';

test('a prompt edit appends a version, and an old version is one call away', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-prompts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalPromptStore({ directory });
  const first = await store.save({ id: 'greet', content: 'Hello {{name}}' });
  assert.equal(first.versions[0].version, 1);
  const second = await store.save({ id: 'greet', content: 'Hi {{name}}, you are {{role}}' });
  assert.equal(second.versions.length, 2);
  assert.equal(second.activeVersion, 2);
  const rolled = await store.activate('greet', 1);
  assert.equal(rolled.activeVersion, 1);
  const reopened = new LocalPromptStore({ directory });
  assert.equal((await reopened.get('greet')).activeVersion, 1);
});

test('rendering refuses a missing variable instead of leaving the placeholder', () => {
  assert.deepEqual(promptVariables('Hi {{name}} and {{ role }}'), ['name', 'role']);
  assert.equal(renderPrompt('Hi {{name}}', { name: 'Ada' }), 'Hi Ada');
  assert.throws(() => renderPrompt('Hi {{name}}', {}), /Missing prompt variables: name/);
});

test('prompts travel in the encrypted backup and come back through the same parser', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-prompts-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalPromptStore({ directory });
  await store.save({ id: 'greet', content: 'Hello {{name}}' });
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), undefined, { prompts: store });
  const envelope = await service.exportBackup('a long enough passphrase');
  const payload = decryptBackup(envelope, 'a long enough passphrase');
  assert.equal(payload.prompts.prompts[0].id, 'greet');
  assert.equal(payload.prompts.prompts[0].versions[0].content, 'Hello {{name}}');

  const restoredDir = await mkdtemp(join(tmpdir(), 'omni-prompts-restore-'));
  t.after(() => rm(restoredDir, { recursive: true, force: true }));
  const restored = new LocalPromptStore({ directory: restoredDir });
  await restored.importState(parsePromptState(payload.prompts));
  assert.equal((await restored.get('greet')).activeVersion, 1);
});
