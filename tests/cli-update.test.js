import assert from 'node:assert/strict';
import test from 'node:test';

import { compareVersions, fetchLatestVersion, checkForUpdate, updateCommand } from '../cli/lib/update.mjs';
import { verbs } from '../cli/index.mjs';
import { update } from '../cli/commands/update.mjs';

/**
 * Update awareness (3.78.0): fail-open, opt-in. The version comparison and the registry decision are pure
 * or injected, so they are asserted without the network; the `update --check` verb is driven with a mocked
 * `fetch`. Nothing here installs anything — the install path is the explicit act of a person running it.
 */

test('compareVersions orders numeric dot versions', () => {
  assert.equal(compareVersions('3.77.0', '3.78.0'), -1);
  assert.equal(compareVersions('3.78.0', '3.77.0'), 1);
  assert.equal(compareVersions('3.78.0', '3.78.0'), 0);
  assert.equal(compareVersions('3.9.0', '3.10.0'), -1, 'numeric, not lexical');
  assert.equal(compareVersions('3.78', '3.78.0'), 0, 'a missing segment reads as 0');
});

test('fetchLatestVersion reads the version and fails open', async () => {
  const ok = await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }) });
  assert.equal(ok, '9.9.9');
  const notOk = await fetchLatestVersion({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(notOk, undefined);
  const throws = await fetchLatestVersion({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(throws, undefined, 'a network error is absence, not a throw');
  const noVersion = await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(noVersion, undefined);
});

test('checkForUpdate reports availability and fails open', async () => {
  const newer = await checkForUpdate('3.77.0', { fetchImpl: async () => ({ ok: true, json: async () => ({ version: '3.78.0' }) }) });
  assert.deepEqual(newer, { current: '3.77.0', latest: '3.78.0', updateAvailable: true });
  const same = await checkForUpdate('3.78.0', { fetchImpl: async () => ({ ok: true, json: async () => ({ version: '3.78.0' }) }) });
  assert.equal(same.updateAvailable, false);
  const offline = await checkForUpdate('3.77.0', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(offline, { current: '3.77.0', latest: undefined, updateAvailable: false });
});

test('the upgrade command is shown, not run', () => {
  assert.equal(updateCommand(), 'npm i -g @hilbras/omnihilbras@latest');
});

test('the update verb is registered with --check', () => {
  assert.ok(verbs.update);
  assert.equal(verbs.update.name, 'update');
  assert.deepEqual(verbs.update.flags, ['--check']);
});

test('update --check reports a newer release without installing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) });
  const lines = [];
  let data;
  const out = { json: false, data: (value) => { data = value; return value; }, line: (text) => lines.push(text), title: (text) => lines.push(text), muted: (text) => text, warn: (text) => text, ok: (text) => text, bad: (text) => text };
  try {
    const code = await update.run({ out, flags: { check: true } });
    assert.equal(code, 0);
    assert.equal(data.updateAvailable, true);
    assert.equal(data.latest, '99.0.0');
    assert.match(lines.join('\n'), /99\.0\.0/, 'the newer version is reported');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
