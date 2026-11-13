import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readZcodeLocalCredential } from '../dist/src/core/zcode-local.js';

/**
 * The local ZCode store, read the way the desktop app writes it.
 *
 * The format is pinned from the shipped app (`out/main/chunk-B7KMLVFU.js` @32585):
 * `enc:v1:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>`, AES-256-GCM, no AAD, key =
 * SHA-256(secret), secret = `ZCODE_CREDENTIAL_SECRET` or `zcode-credential-fallback:<platform>:<home>:<user>`.
 * These tests use an explicit secret so they do not depend on the machine's username.
 */

const SECRET = 'test-only-secret';

function encrypt(value, secret = SECRET) {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

async function store(home, entries, telemetry) {
  await mkdir(join(home, '.zcode', 'v2'), { recursive: true });
  await writeFile(join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify(entries), 'utf8');
  if (telemetry) await writeFile(join(home, '.zcode', 'v2', 'telemetry-state.json'), JSON.stringify(telemetry), 'utf8');
}

test('reads the token, the account id and the device id from the app store', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zcode-local-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await store(
    home,
    {
      zcodejwttoken: encrypt('header.payload.signature'),
      'oauth:active_provider': encrypt('zai'),
      'oauth:zai:user_info': encrypt(JSON.stringify({ id: 'account-123' })),
    },
    { deviceMid: '11111111-1111-4111-8111-111111111111' },
  );

  const credential = await readZcodeLocalCredential({ homeDir: home, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(credential.token, 'header.payload.signature');
  assert.equal(credential.activeProvider, 'zai');
  assert.equal(credential.accountUuid, 'account-123');
  assert.equal(credential.deviceMid, '11111111-1111-4111-8111-111111111111');
});

test('a store written under a different secret is a clear error, not a crash', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zcode-local-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await store(home, { zcodejwttoken: encrypt('header.payload.signature', 'another-secret') });

  await assert.rejects(
    () => readZcodeLocalCredential({ homeDir: home, env: { ZCODE_CREDENTIAL_SECRET: SECRET } }),
    /could not be decrypted on this machine/,
  );
});

test('no ZCode app on this machine names the file and the alternative', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zcode-local-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  await assert.rejects(
    () => readZcodeLocalCredential({ homeDir: home, env: { ZCODE_CREDENTIAL_SECRET: SECRET } }),
    (error) => {
      assert.match(error.message, /No ZCode desktop credential found/);
      assert.match(error.message, /paste the token/);
      return true;
    },
  );
});

test('a store without zcodejwttoken says to sign in again', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zcode-local-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await store(home, { 'oauth:active_provider': encrypt('zai') });

  await assert.rejects(
    () => readZcodeLocalCredential({ homeDir: home, env: { ZCODE_CREDENTIAL_SECRET: SECRET } }),
    /no `zcodejwttoken`/,
  );
});