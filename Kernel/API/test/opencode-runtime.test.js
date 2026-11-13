import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureOpencodeService,
  installOpencodeRuntime,
  opencodeAssetName,
  opencodeBinaryPath,
  opencodeRuntimeStatus,
  resolveOpencodeBinary,
} from '../dist/src/core/opencode-runtime.js';

/**
 * The OpenCode runtime: finding it, installing it, starting it.
 *
 * A device that has never seen OpenCode cannot use the Console's free models — measured, the same
 * request from Node, Bun and curl is refused while the client's own service answers. So the gateway
 * can install that server itself, which is what these tests pin.
 */

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeBinary(path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\necho 9.9.9\n');
  await chmod(path, 0o755);
  return path;
}

/** An environment that cannot see this machine: no PATH, no HOME, no registered service. */
async function isolatedEnv(t, extra = {}) {
  const home = await tempDir(t);
  return { PATH: '', HOME: home, XDG_STATE_HOME: join(home, 'state'), ...extra };
}

test('the binary is chosen by the most explicit decision first', async (t) => {
  const dataDir = await tempDir(t);
  const env = await isolatedEnv(t);
  const explicit = await fakeBinary(join(await tempDir(t), 'opencode'));
  const installed = await fakeBinary(opencodeBinaryPath({ dataDir }));

  // An explicit path wins over everything…
  assert.equal(await resolveOpencodeBinary({ dataDir, env: { ...env, OMNIHILBRAS_OPENCODE_BINARY: explicit } }), explicit);
  // …then the copy this gateway installed…
  assert.equal(await resolveOpencodeBinary({ dataDir, env }), installed);
  // …and nothing at all is a state, not an error.
  assert.equal(await resolveOpencodeBinary({ dataDir: await tempDir(t), env }), undefined);
});

test('a machine with the binary but no service gets one started, and a machine with neither is reported', async (t) => {
  const dataDir = await tempDir(t);
  const binary = await fakeBinary(opencodeBinaryPath({ dataDir }));
  const endpoint = { url: 'http://127.0.0.1:49374', password: 'pw' };
  const started = [];

  const env = await isolatedEnv(t);
  const result = await ensureOpencodeService({
    dataDir,
    env,
    start: (path) => { started.push(path); },
    waitForService: async () => endpoint,
  });
  assert.deepEqual(started, [binary], 'the binary this gateway installed is what gets started');
  assert.deepEqual(result, endpoint);

  // Nothing installed: no spawn, no throw — the caller reports "no OpenCode here".
  const empty = await tempDir(t);
  const spawnAttempts = [];
  assert.equal(await ensureOpencodeService({ dataDir: empty, env: await isolatedEnv(t), start: (p) => spawnAttempts.push(p) }), undefined);
  assert.deepEqual(spawnAttempts, []);

  // And an operator who said "off" is obeyed even when a binary is lying there.
  const off = await ensureOpencodeService({ dataDir, env: { ...env, OMNIHILBRAS_OPENCODE_SERVICE: 'off' }, start: (p) => started.push(`off:${p}`) });
  assert.equal(off, undefined);
  assert.equal(started.length, 1, 'nothing was started after the operator turned it off');
});

test('installing unpacks the official asset, proves the binary starts, and records what it wrote', async (t) => {
  const dataDir = await tempDir(t);
  const staging = await tempDir(t);
  await fakeBinary(join(staging, 'opencode'));
  const archive = join(staging, 'opencode-linux-x64.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', staging, 'opencode']);
  assert.equal(packed.status, 0, 'the fixture archive must build');

  const bytes = await readFile(archive);
  const seen = [];
  const result = await installOpencodeRuntime({
    dataDir,
    version: '2.0.28',
    platform: 'linux',
    arch: 'x64',
    fetch: async (url) => {
      seen.push(String(url));
      return new Response(bytes, { status: 200 });
    },
  });

  assert.deepEqual(seen, ['https://github.com/anomalyco/opencode/releases/download/v2.0.28/opencode-linux-x64.tar.gz']);
  assert.equal(result.path, opencodeBinaryPath({ dataDir }));
  assert.equal(result.reportedVersion, '9.9.9', 'the installed binary is run, not assumed to work');
  assert.deepEqual(await resolveOpencodeBinary({ dataDir, env: { PATH: '', HOME: '/nonexistent' } }), opencodeBinaryPath({ dataDir }));

  const record = JSON.parse(await readFile(join(dataDir, 'runtime', 'opencode', 'install.json'), 'utf8'));
  assert.equal(record.version, '2.0.28');
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.reportedVersion, '9.9.9');

  const status = await opencodeRuntimeStatus({ dataDir, env: await isolatedEnv(t) });
  assert.equal(status.installed, true);
  assert.equal(status.installPath, opencodeBinaryPath({ dataDir }));
});

test('a release that has no asset for this platform says so instead of failing vaguely', async (t) => {
  const dataDir = await tempDir(t);
  await assert.rejects(
    () => installOpencodeRuntime({ dataDir, version: '2.0.28', platform: 'linux', arch: 'x64', fetch: async () => new Response('not found', { status: 404 }) }),
    /has no opencode-linux-x64\.tar\.gz for v2\.0\.28/,
  );
});

test('asset names follow the official installer, per platform', () => {
  assert.equal(opencodeAssetName('linux', 'x64'), 'opencode-linux-x64.tar.gz');
  assert.equal(opencodeAssetName('darwin', 'arm64'), 'opencode-darwin-arm64.tar.gz');
  assert.equal(opencodeAssetName('win32', 'x64'), 'opencode-windows-x64.zip');
});

test('a device with no OpenCode at all is only downloaded for when the operator asked for it', async (t) => {
  const dataDir = await tempDir(t);
  const env = await isolatedEnv(t);
  const installed = [];

  // `auto` — the default — starts what is here and downloads nothing.
  assert.equal(await ensureOpencodeService({ dataDir, env, start: () => installed.push('start') }), undefined);
  assert.deepEqual(installed, []);

  // `install` — opt-in, because it is a ~200 MB download triggered by a model request.
  const endpoint = { url: 'http://127.0.0.1:49374', password: 'pw' };
  const result = await ensureOpencodeService({
    dataDir,
    env: { ...env, OMNIHILBRAS_OPENCODE_SERVICE: 'install' },
    install: async () => { await fakeBinary(opencodeBinaryPath({ dataDir })); },
    start: () => installed.push('start'),
    waitForService: async () => endpoint,
  });
  assert.deepEqual(installed, ['start'], 'the freshly installed binary is what gets started');
  assert.deepEqual(result, endpoint);

  // A download that fails is "no runtime here", not a broken turn.
  const other = await tempDir(t);
  const failed = await ensureOpencodeService({
    dataDir: other,
    env: { ...env, OMNIHILBRAS_OPENCODE_SERVICE: 'install' },
    install: async () => { throw new Error('offline'); },
    start: () => installed.push('unexpected'),
  });
  assert.equal(failed, undefined);
  assert.deepEqual(installed, ['start']);
});
