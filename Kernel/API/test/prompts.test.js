import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPromptStore, promptVariables, renderPrompt } from '../dist/src/core/prompts.js';

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
