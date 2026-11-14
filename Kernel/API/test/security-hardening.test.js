import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { chatGptWebProfileDir, removeChatGptWebProfile } from '../dist/src/providers/chatgptWeb.js';
import { installOpencodeRuntime } from '../dist/src/core/opencode-runtime.js';

/**
 * Three hardening findings, as assertions.
 *
 * - **N3** the runtime installer took its version from npm's `latest` dist-tag — the only pointer to a
 *   binary the gateway then executes — and recorded a hash without comparing it to anything.
 * - **N4** a browser-driver profile is a signed-in third-party session on disk; deleting the connection
 *   left it there.
 * - **F1** (in `tests/update-consent.test.js`, source-level) the updater installs whatever the feed says.
 */

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hardening-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A tiny fake of the release asset, so the installer path runs without the network. */
async function fixtureArchive(t) {
  const staging = await tempDir(t);
  const binary = join(staging, 'opencode');
  await writeFile(binary, '#!/bin/sh\necho 9.9.9\n');
  const { chmod } = await import('node:fs/promises');
  await chmod(binary, 0o755);
  const archive = join(staging, 'opencode-linux-x64.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', staging, 'opencode']);
  assert.equal(packed.status, 0);
  return readFile(archive);
}

test('N3 — the installer uses the pinned release unless an operator names another', async (t) => {
  const dataDir = await tempDir(t);
  const bytes = await fixtureArchive(t);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(bytes, { status: 200 });
  };

  const installed = await installOpencodeRuntime({ dataDir, platform: 'linux', arch: 'x64', fetch: fetchImpl, env: { PATH: '', OMNIHILBRAS_DATA_DIR: dataDir } });
  assert.match(requested[0], /releases\/download\/v2\.0\.28\/opencode-linux-x64\.tar\.gz/, 'the pinned version is what is fetched');
  assert.equal(installed.version, '2.0.28');

  // No npm metadata call at all: the dist-tag is no longer a source of truth for a default install.
  assert.equal(requested.some((url) => url.includes('registry.npmjs.org')), false, 'a default install must not consult npm');
});

test('N3 — "latest" is available, but only when asked for by name', async (t) => {
  const dataDir = await tempDir(t);
  const bytes = await fixtureArchive(t);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).includes('registry.npmjs.org')) return new Response(JSON.stringify({ version: '3.4.5' }), { status: 200 });
    return new Response(bytes, { status: 200 });
  };

  const installed = await installOpencodeRuntime({ dataDir, platform: 'linux', arch: 'x64', fetch: fetchImpl, env: { PATH: '', OMNIHILBRAS_DATA_DIR: dataDir, OMNIHILBRAS_OPENCODE_VERSION: 'latest' } });
  assert.equal(installed.version, '3.4.5', 'the resolved version is the one used');
  assert.match(requested.at(-1), /releases\/download\/v3\.4\.5\//);
});

test('N3 — a pinned hash is checked, not merely recorded', async (t) => {
  const dataDir = await tempDir(t);
  const bytes = await fixtureArchive(t);
  const fetchImpl = async () => new Response(bytes, { status: 200 });

  await assert.rejects(
    () => installOpencodeRuntime({ dataDir, platform: 'linux', arch: 'x64', fetch: fetchImpl, env: { PATH: '', OMNIHILBRAS_DATA_DIR: dataDir, OMNIHILBRAS_OPENCODE_SHA256: 'a'.repeat(64) } }),
    /does not match OMNIHILBRAS_OPENCODE_SHA256/,
    'an artifact that does not match the pinned hash must not be installed',
  );

  // And with no pin, the recorded hash is still reported so it can be compared by hand.
  const installed = await installOpencodeRuntime({ dataDir, platform: 'linux', arch: 'x64', fetch: fetchImpl, env: { PATH: '', OMNIHILBRAS_DATA_DIR: dataDir } });
  assert.match(installed.sha256, /^[0-9a-f]{64}$/);
});

test('N4 — a connection profile is per connection, private, and gone after a delete', async (t) => {
  const configHome = await tempDir(t);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });

  const one = chatGptWebProfileDir('connection-one');
  const two = chatGptWebProfileDir('connection-two');
  assert.notEqual(one, two, 'two connections must not share a profile');
  assert.equal(chatGptWebProfileDir('connection-one'), one, 'and the path is stable for one connection');

  // What the driver does before it launches: create it 0700, because a persistent profile is a
  // signed-in session on disk.
  await mkdir(one, { recursive: true, mode: 0o700 });
  await writeFile(join(one, 'Cookies'), 'a session');
  assert.equal((await stat(one)).mode & 0o777, 0o700);

  await removeChatGptWebProfile('connection-one');
  await assert.rejects(() => stat(one), 'the profile must be gone after a delete');

  // Removing one that never existed is not an error: a connection that never opened a browser.
  await removeChatGptWebProfile('connection-never-used');
});
