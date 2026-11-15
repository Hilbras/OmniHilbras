import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureOpencodeService,
  ensureOwnServiceConfig,
  inspectOwnService,
  opencodeOwnServiceConfigFile,
  opencodeOwnServiceEnv,
  opencodeOwnServiceFile,
  opencodeOwnServicePidFile,
  opencodeOwnServicePort,
  opencodeOwnServiceRoot,
  stopOpencodeService,
} from '../dist/src/core/opencode-runtime.js';

/**
 * The service instance this gateway owns.
 *
 * The change is that the gateway stops borrowing the user's OpenCode: it keeps its own config, password,
 * state and pid record, so "running" means an instance this process started and will stop again. The
 * session that produced this file was spent finding out what could *not* be changed, and the tests carry
 * those measurements so nobody has to repeat them.
 */

const tempData = async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'owned-service-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
};

test('the port is ours to choose, and deliberately not the one the user’s app holds', () => {
  /**
   * This assertion claimed the opposite an hour before it was written — that the free tier required the
   * canonical port — because two measurements taken at different times said `49390 → 429` and
   * `49374 → 200`. Holding the directories fixed, both ports answer:
   *
   *     our config + their state + 49374 -> 200
   *     our config + their state + 49390 -> 200
   *     our config + our state   + either -> 429
   *
   * The variable was the state directory, never the port. 49390 is kept because it lets this instance run
   * alongside the user's own instead of racing it for 49374.
   */
  assert.equal(opencodeOwnServicePort({}), 49_390);
  assert.equal(opencodeOwnServicePort({ OMNIHILBRAS_OPENCODE_PORT: '51000' }), 51_000, 'it can still be moved');
  for (const bad of ['0', 'lots', '70000', '-1', '1.5']) {
    assert.equal(opencodeOwnServicePort({ OMNIHILBRAS_OPENCODE_PORT: bad }), 49_390, bad);
  }
  assert.notEqual(opencodeOwnServicePort({}), 49_374, 'not the port the user\'s own instance uses');
});

test('our config is ours, and the registration file is deliberately the canonical one', async (t) => {
  const dataDir = await tempData(t);
  const options = { dataDir, env: {} };
  const root = opencodeOwnServiceRoot(options);

  // Ours: a password of our own, in our own directory.
  assert.equal(opencodeOwnServiceConfigFile(options).startsWith(root), true);
  assert.equal(opencodeOwnServicePidFile(options).startsWith(root), true);

  /**
   * Not ours, and it cannot be: `XDG_STATE_HOME` is where the free-tier qualification lives — an instance
   * with its own empty state directory answered `429` for the same binary, port, account and body that
   * answered `200` from the canonical one. So the registration file is the canonical file, which is also
   * the file the user's own OpenCode reads. It names our instance while ours runs.
   */
  assert.equal(opencodeOwnServiceFile(options), join('/home/gin/.local', 'state', 'opencode', 'service.json').replace('/home/gin', options.env.HOME ?? process.env.HOME));
  assert.equal(opencodeOwnServiceFile(options).includes(join(root, 'state')), false, 'the state dir is not redirected into ours');
});

test('our config is written once, locked down, and its password is kept', async (t) => {
  const options = { dataDir: await tempData(t) };
  const first = await ensureOwnServiceConfig(options);

  const raw = await readFile(opencodeOwnServiceConfigFile(options), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(typeof parsed.password, 'string');
  assert.ok(parsed.password.length >= 20, 'a password long enough to be one');
  assert.equal((await stat(opencodeOwnServiceConfigFile(options))).mode & 0o777, 0o600, 'owner-only');

  const second = await ensureOwnServiceConfig(options);
  assert.equal(second.password, first.password, 'an existing password is kept');
  // Rotating it under a running instance would invalidate the registration it just wrote.
  assert.equal(JSON.parse(await readFile(opencodeOwnServiceConfigFile(options), 'utf8')).password, first.password);
});

test('the child environment redirects the config directory and leaves the state directory alone', () => {
  const env = opencodeOwnServiceEnv({ dataDir: '/tmp/example', env: { PATH: '/usr/bin', HOME: '/home/x' } });
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment survives');
  assert.equal(env.HOME, '/home/x');
  assert.equal(env.XDG_CONFIG_HOME, join('/tmp/example', 'runtime', 'opencode', 'service', 'config'), 'our password, our config');
  // The whole finding, asserted: redirecting this is what cost the free tier.
  assert.equal('XDG_STATE_HOME' in env, false, 'the state directory is not redirected');
  const inherited = opencodeOwnServiceEnv({ dataDir: '/tmp/example', env: { XDG_STATE_HOME: '/custom/state' } });
  assert.equal(inherited.XDG_STATE_HOME, '/custom/state', 'and a state directory that is already set is passed through');
});

test('stopping claims nothing when there is no instance of ours', async (t) => {
  const options = { dataDir: await tempData(t) };
  assert.equal(await stopOpencodeService(options), false, 'no pid file means nothing to stop');
  // And a pid file naming a pid that is not ours must not be signalled either: the file records what we
  // started, and a reused pid would otherwise mean killing something unrelated.
  await mkdir(opencodeOwnServiceRoot(options), { recursive: true });
  await writeFile(opencodeOwnServicePidFile(options), '999999');
  assert.equal(await stopOpencodeService(options), false, 'a pid that is not running is not signalled');
});

test('the options reach the spawn — the bug that made the first version look broken', async (t) => {
  const dataDir = await tempData(t);
  // The registration file is deliberately the canonical one now, so a test that wants "nothing is
  // registered" has to say where to look: an empty state directory of its own.
  const emptyState = await mkdtemp(join(tmpdir(), 'owned-service-state-'));
  t.after(() => rm(emptyState, { recursive: true, force: true }));
  const seen = [];
  await ensureOpencodeService({
    dataDir,
    env: { ...process.env, OMNIHILBRAS_OPENCODE_SERVICE: 'auto', XDG_STATE_HOME: emptyState },
    // The binary is "found" without touching the machine, and the start is watched rather than performed.
    start: (binary, options) => { seen.push({ binary, dataDir: options?.dataDir }); },
    waitForService: (options) => {
      seen.push({ waitedOn: options?.dataDir });
      return undefined;
    },
    // The old code called `start(binary)` and dropped the options, so the spawn used the *default* data
    // directory while the wait polled the caller's — an instance that came up somewhere else and a wait
    // that timed out on a service running perfectly well.
  }).catch(() => undefined);

  assert.deepEqual(seen, [{ binary: seen[0]?.binary, dataDir }, { waitedOn: dataDir }], 'start and wait receive the same options');
});

test('ownership is claimed only when our own pid file names the registered process', async (t) => {
  const options = { dataDir: await tempData(t) };
  // A registration in our directory that we did not start — someone ran the binary by hand against our
  // paths. It is discovered and used, and it is not ours to kill.
  await mkdir(join(opencodeOwnServiceRoot(options), 'state', 'opencode'), { recursive: true });
  await writeFile(opencodeOwnServiceFile(options), JSON.stringify({ id: 'x', version: '2.0.28', url: 'http://127.0.0.1:49374', pid: 4242, password: 'p' }));
  const withoutPid = await inspectOwnService(options);
  assert.equal(withoutPid.owned, false, 'registered is not the same as started by us');

  await writeFile(opencodeOwnServicePidFile(options), '4242');
  const withPid = await inspectOwnService(options);
  assert.equal(withPid.owned, true, 'our pid file naming that process is what makes it ours');
});
