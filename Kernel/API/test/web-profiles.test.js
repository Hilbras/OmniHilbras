import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptBackup } from '../dist/src/core/backup.js';
import { exportWebProfiles, importWebProfiles, parseWebProfilesState } from '../dist/src/core/web-profiles.js';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { chatGptWebProfileDir } from '../dist/src/providers/chatgptWeb.js';
import { geminiWebProfileDir } from '../dist/src/providers/geminiWeb.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * The web-popup profiles: what travels, what must not, and what is refused.
 *
 * An interactive sign-in to ChatGPT Web or Gemini Web writes the session into a browser profile on disk, so
 * a backup that skipped it restores an installation that asks the user to sign in again — and one that
 * carried the profile whole would drag ~6.9 MB of Chromium cache per connection into a payload capped at
 * 20 MiB. These tests pin both halves, plus the rule that matters most: a path from the file may never name
 * a file outside the profile directory it is written into.
 */

/** A temporary XDG config home, so the drivers' profile directories land somewhere disposable. */
async function withConfigHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'omnihilbras-web-profiles-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return home;
}

async function writeProfile(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
}

test('the session files travel and the caches do not', async (t) => {
  await withConfigHome(t);
  const directory = chatGptWebProfileDir('connection-1');
  await writeProfile(directory, {
    'Default/Cookies': 'sqlite-session-cookie',
    'Default/Local Storage/leveldb/000001.log': 'local-storage',
    'Default/IndexedDB/https_chatgpt.com_0.indexeddb.leveldb/000005.ldb': 'indexed-db',
    'Default/Cache/data_0': 'x'.repeat(64 * 1024),
    'Default/Code Cache/js/abcdef': 'cache',
  });

  const section = await exportWebProfiles([{ id: 'connection-1', providerId: 'chatgpt-web' }]);
  assert.equal(section.profiles.length, 1);
  const files = section.profiles[0].files;
  assert.deepEqual(Object.keys(files).sort(), [
    'Default/Cookies',
    'Default/IndexedDB/https_chatgpt.com_0.indexeddb.leveldb/000005.ldb',
    'Default/Local Storage/leveldb/000001.log',
  ]);
  assert.equal(Buffer.from(files['Default/Cookies'], 'base64').toString('utf8'), 'sqlite-session-cookie');

  await rm(directory, { recursive: true, force: true });
  await importWebProfiles(section, ['connection-1'], () => 'chatgpt-web');
  assert.equal(await readFile(join(directory, 'Default/Cookies'), 'utf8'), 'sqlite-session-cookie');
  const mode = (await stat(directory)).mode & 0o777;
  assert.equal(mode, 0o700, 'a restored profile directory is not owner-only');
});

test('a profile the file does not carry is removed rather than left behind', async (t) => {
  await withConfigHome(t);
  const stale = geminiWebProfileDir('connection-2');
  await writeProfile(stale, { 'Default/Cookies': 'stale-session' });

  await importWebProfiles({ version: 1, profiles: [] }, ['connection-2'], () => 'gemini-web');
  assert.equal(await stat(stale).catch(() => undefined), undefined, 'a session the file never carried survived the import');
});

test('a path that climbs out of the profile is refused', () => {
  const escape = { version: 1, profiles: [{ providerId: 'chatgpt-web', connectionId: 'c', files: { '../secrets.key': 'AAAA' } }] };
  assert.throws(() => parseWebProfilesState(escape), /outside the profile directory/);
  assert.throws(() => parseWebProfilesState({ version: 1, profiles: [{ providerId: 'chatgpt-web', connectionId: 'c', files: { '/etc/passwd': 'AAAA' } }] }), /outside the profile directory/);
  assert.throws(() => parseWebProfilesState({ version: 2, profiles: [] }), /not readable/);
  const duplicate = { version: 1, profiles: [{ providerId: 'chatgpt-web', connectionId: 'c', files: {} }, { providerId: 'chatgpt-web', connectionId: 'c', files: {} }] };
  assert.throws(() => parseWebProfilesState(duplicate), /two web profiles/);
});

test('a gateway backup carries the profile, and a delete forgets it', async (t) => {
  await withConfigHome(t);
  const connections = new InMemoryConnectionStore();
  await connections.save({
    id: 'chatgpt-account',
    providerId: 'chatgpt-web',
    name: 'ChatGPT',
    endpoint: 'https://chatgpt.com',
    priority: 1,
    proxyPool: 'none',
  }, { type: 'api-key', value: 'pasted-cookie' });
  const service = new GatewayService(new ProviderRegistry(), connections, connections, new InMemoryApiKeyStore());

  const directory = chatGptWebProfileDir('chatgpt-account');
  await writeProfile(directory, { 'Default/Cookies': 'device-identity' });

  const backup = await service.exportBackup('correct horse battery');
  const payload = decryptBackup(backup, 'correct horse battery');
  assert.equal(payload.webProfiles.profiles.length, 1);
  assert.equal(payload.webProfiles.profiles[0].connectionId, 'chatgpt-account');

  const target = new InMemoryConnectionStore();
  const restored = new GatewayService(new ProviderRegistry(), target, target, new InMemoryApiKeyStore());
  // Removed before the import rather than after, so the file that lands is the one the payload carried.
  await rm(directory, { recursive: true, force: true });
  const result = await restored.importBackup('correct horse battery', backup);
  assert.equal(result.sections.webProfiles, 1);
  assert.equal(await readFile(join(directory, 'Default/Cookies'), 'utf8'), 'device-identity');

  await restored.removeConnection('chatgpt-account');
  assert.equal(await stat(directory).catch(() => undefined), undefined, 'deleting the connection left its signed-in profile on disk');
});
