import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LocalConnectionStore } from '../dist/index.js';

const connectionInput = {
  id: 'openrouter',
  providerId: 'openrouter',
  name: 'OpenRouter local',
  endpoint: 'https://openrouter.ai/api/v1',
  priority: 1,
  proxyPool: 'none',
};

async function vault(t, masterKey = Buffer.alloc(32, 3)) {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey });
  await store.save(connectionInput, { type: 'api-key', value: 'stored-secret' });
  return { directory, masterKey };
}

test('a tampered ciphertext is refused, not decrypted to garbage', async (t) => {
  const { directory, masterKey } = await vault(t);
  const path = join(directory, 'secrets.enc.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  envelope.ciphertext = bytes.toString('base64');
  await writeFile(path, JSON.stringify(envelope) + '\n');

  const reopened = new LocalConnectionStore({ directory, masterKey });
  await assert.rejects(() => reopened.get('openrouter'), 'GCM authentication must fail on a modified ciphertext');
});

test('a tampered authentication tag is refused', async (t) => {
  const { directory, masterKey } = await vault(t);
  const path = join(directory, 'secrets.enc.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const tag = Buffer.from(envelope.authTag, 'base64');
  tag[0] ^= 0x01;
  envelope.authTag = tag.toString('base64');
  await writeFile(path, JSON.stringify(envelope) + '\n');

  const reopened = new LocalConnectionStore({ directory, masterKey });
  await assert.rejects(() => reopened.get('openrouter'));
});

test('a secrets file that is not JSON fails closed', async (t) => {
  const { directory, masterKey } = await vault(t);
  await writeFile(join(directory, 'secrets.enc.json'), '{"version":1,"ciphertext":');
  const reopened = new LocalConnectionStore({ directory, masterKey });
  await assert.rejects(() => reopened.get('openrouter'));
});

test('an empty secrets ciphertext is refused as corrupt', async (t) => {
  const { directory, masterKey } = await vault(t);
  const path = join(directory, 'secrets.enc.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.ciphertext = '';
  await writeFile(path, JSON.stringify(envelope) + '\n');
  const reopened = new LocalConnectionStore({ directory, masterKey });
  await assert.rejects(() => reopened.get('openrouter'), /empty/);
});

test('an empty key file is refused rather than used as a blank key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-emptykey-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'secrets.key'), '\n', { mode: 0o600 });
  const store = new LocalConnectionStore({ directory });
  await assert.rejects(() => store.save(connectionInput, { type: 'api-key', value: 'x' }), /empty/);
});

test('a state directory that is a symbolic link is refused', async (t) => {
  const real = await mkdtemp(join(tmpdir(), 'omnihilbras-real-'));
  const linkParent = await mkdtemp(join(tmpdir(), 'omnihilbras-link-'));
  t.after(() => Promise.all([rm(real, { recursive: true, force: true }), rm(linkParent, { recursive: true, force: true })]));
  const link = join(linkParent, 'state');
  await symlink(real, link);
  const store = new LocalConnectionStore({ directory: link, masterKey: Buffer.alloc(32, 4) });
  await assert.rejects(() => store.save(connectionInput, { type: 'api-key', value: 'x' }), /not a regular directory/);
});

test('a secrets file replaced by a symbolic link is refused, not written through', async (t) => {
  const { directory, masterKey } = await vault(t);
  const target = join(directory, 'elsewhere.json');
  await writeFile(target, '{}');
  const path = join(directory, 'secrets.enc.json');
  await rm(path);
  await symlink(target, path);
  const store = new LocalConnectionStore({ directory, masterKey });
  await assert.rejects(() => store.save(connectionInput, { type: 'api-key', value: 'y' }), /not a regular file|symbolic link/);
  assert.equal((await lstat(path)).isSymbolicLink(), true, 'the link itself is left in place');
});

test('an interrupted write leaves the previous vault readable, not a partial file', async (t) => {
  const { directory, masterKey } = await vault(t);
  const before = await readFile(join(directory, 'secrets.enc.json'), 'utf8');
  // A crash between writing the temporary file and renaming it leaves a stray `.tmp`, never a half-written
  // target. Simulate the stray file and confirm the real vault is untouched and still loads.
  await writeFile(join(directory, `secrets.enc.json.${process.pid}.deadbeef.tmp`), '{"partial":');
  assert.equal(await readFile(join(directory, 'secrets.enc.json'), 'utf8'), before);
  const reopened = new LocalConnectionStore({ directory, masterKey });
  assert.equal((await reopened.get('openrouter')).value, 'stored-secret');
});

test('a credentials file is written owner-only', async (t) => {
  const { directory } = await vault(t);
  const mode = (await lstat(join(directory, 'secrets.enc.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
});
