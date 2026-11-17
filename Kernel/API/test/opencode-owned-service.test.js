import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:net';
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
  opencodeRuntimeStatus,
  startOpencodeService,
  startOpencodeSupervisor,
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

/**
 * A stand-in binary, because these tests used to depend on the developer's own install.
 *
 * `ensureOpencodeService` returns `undefined` when no binary is found — correct for a machine with no OpenCode — and
 * `resolveOpencodeBinary` looks at `OMNIHILBRAS_OPENCODE_BINARY`, our own install path, `~/.opencode/bin` and `PATH`.
 * On a workstation with the OpenCode client installed the first two tests therefore passed; on CI, where nothing is
 * installed, the function returned before calling `start`, and they failed with `seen: []`. The suite has been red in
 * CI since this feature landed, for a reason that says nothing about the feature.
 *
 * The stand-in is a real executable file, so the resolution path is still the one under test.
 */
const fakeBinary = async (dir) => {
  const path = join(dir, 'opencode');
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path;
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

test('everything an instance needs is ours: config, state, registration and pid', async (t) => {
  const dataDir = await tempData(t);
  const options = { dataDir, env: {} };
  const root = opencodeOwnServiceRoot(options);

  assert.equal(opencodeOwnServiceConfigFile(options).startsWith(root), true, 'our own password');
  assert.equal(opencodeOwnServicePidFile(options).startsWith(root), true, 'our own pid record');

  /**
   * And the registration file too — which is what stops OpenCode killing this instance.
   *
   * The app reaps the occupant of the *canonical* registration when it starts: measured, ours was dead within
   * seconds of the app opening, and the canonical file had been rewritten to the app's url and pid. A file
   * inside our own state directory is a file no OpenCode process reads or writes.
   *
   * This test asserted the opposite an hour before this line was written, on measurements that turned out to be
   * confounded by the free tier's own rate limit. See `opencodeOwnServiceEnv` for the interleaved run that
   * replaced them.
   */
  assert.equal(opencodeOwnServiceFile(options).startsWith(join(root, 'state')), true, 'our own registration');
  assert.notEqual(
    opencodeOwnServiceFile(options),
    join(process.env.HOME ?? '', '.local', 'state', 'opencode', 'service.json'),
    'not the canonical file the app reads',
  );
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

test('both directories are ours, and the data directory is left alone', () => {
  const env = opencodeOwnServiceEnv({ dataDir: '/tmp/example', env: { PATH: '/usr/bin', HOME: '/home/x' } });
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment survives');
  assert.equal(env.HOME, '/home/x');
  assert.equal(env.XDG_CONFIG_HOME, join('/tmp/example', 'runtime', 'opencode', 'service', 'config'), 'our password, our config');
  assert.equal(env.XDG_STATE_HOME, join('/tmp/example', 'runtime', 'opencode', 'service', 'state'), 'our registration, our lock');
  // The account credentials the free tier is derived from live in the data directory. Reading them is what the
  // Console provider *is*; redirecting it would leave a machine that can never use a free model.
  assert.equal('XDG_DATA_HOME' in env, false, 'the data directory is not redirected');
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
    env: { ...process.env, OMNIHILBRAS_OPENCODE_SERVICE: 'auto', XDG_STATE_HOME: emptyState, OMNIHILBRAS_OPENCODE_PORT: String(await freePort()), OMNIHILBRAS_OPENCODE_BINARY: await fakeBinary(dataDir) },
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

test('a registration whose process is gone is not adopted — the 502 this shipped with', async (t) => {
  const dataDir = await tempData(t);
  const emptyState = await mkdtemp(join(tmpdir(), 'owned-service-stale-'));
  t.after(() => rm(emptyState, { recursive: true, force: true }));
  const registration = join(emptyState, 'opencode', 'service.json');
  await mkdir(join(emptyState, 'opencode'), { recursive: true });
  // Exactly the file a service leaves behind when the gateway is SIGKILLed, or the machine loses power: a
  // url, a password, and a pid nobody is running.
  await writeFile(registration, JSON.stringify({ id: 'x', version: '2.0.28', url: 'http://127.0.0.1:49390', pid: 999_999, password: 'p' }));

  let started = false;
  await ensureOpencodeService({
    dataDir,
    env: { ...process.env, XDG_STATE_HOME: emptyState, OMNIHILBRAS_OPENCODE_SERVICE: 'auto', OMNIHILBRAS_OPENCODE_PORT: String(await freePort()), OMNIHILBRAS_OPENCODE_BINARY: await fakeBinary(dataDir) },
    start: () => { started = true; },
    waitForService: () => undefined,
  }).catch(() => undefined);

  // Adopting the corpse is what made the first boot after this feature report `serviceRunning: true` for an
  // empty port and answer its first turn with `502 PROVIDER_REQUEST_FAILED`.
  assert.equal(started, true, 'the gateway starts its own instance instead of adopting a dead one');
});

test('ownership is claimed only when our own pid file names the registered process', async (t) => {
  const options = { dataDir: await tempData(t) };
  // A registration in our directory that we did not start — someone ran the binary by hand against our
  // paths. It is discovered and used, and it is not ours to kill.
  const registration = opencodeOwnServiceFile(options);
  await mkdir(join(opencodeOwnServiceRoot(options), 'state', 'opencode'), { recursive: true });
  // A live pid — this test process — because ownership also requires the process to be there at all.
  await writeFile(registration, JSON.stringify({ id: 'x', version: '2.0.28', url: 'http://127.0.0.1:49374', pid: process.pid, password: 'p' }));

  const withoutPid = await inspectOwnService(options);
  assert.equal(withoutPid.owned, false, 'registered is not the same as started by us');

  await mkdir(opencodeOwnServiceRoot(options), { recursive: true });
  await writeFile(opencodeOwnServicePidFile(options), String(process.pid));
  const withPid = await inspectOwnService(options);
  assert.equal(withPid.owned, true, 'our pid file naming that process is what makes it ours');
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the supervisor starts an instance when nothing is running, and stops when told', async (t) => {
  const dataDir = await tempData(t);
  const emptyState = await mkdtemp(join(tmpdir(), 'owned-service-supervisor-'));
  t.after(() => rm(emptyState, { recursive: true, force: true }));
  let started = 0;
  const stop = startOpencodeSupervisor({
    dataDir,
    intervalMs: 25,
    // A binary that exists — the probe only asks whether one is there — and an empty state directory, so
    // nothing is live and the supervisor has to act.
    env: { ...process.env, OMNIHILBRAS_OPENCODE_SERVICE: 'auto', OMNIHILBRAS_OPENCODE_BINARY: process.execPath, XDG_STATE_HOME: emptyState },
    ensure: async () => { started += 1; },
    log: () => {},
  });
  // Long enough to survive a busy machine: the assertion is "it keeps checking", not a frame budget.
  //
  // It waited a fixed 400 ms until this was measured twice inside `pnpm test:gateway` (a suite that runs many
  // files at once, on a machine that is also running the dev servers): the supervisor had ticked once and the
  // assertion failed while it was behaving perfectly. The property is that it keeps going, so that is what is
  // waited for — a deadline, not a stopwatch.
  const deadline = Date.now() + 5_000;
  while (started < 2 && Date.now() < deadline) await wait(25);
  stop();
  const settled = started;
  assert.ok(settled >= 2, `it keeps checking while the gateway lives (saw ${settled})`);

  await wait(90);
  // A supervisor that outlives its gateway would start an instance during shutdown, which is the process-leak
  // this whole file is careful about.
  assert.equal(started, settled, 'stopping it stops it');
});

test('the supervisor leaves a service that is already running alone', async (t) => {
  const dataDir = await tempData(t);
  const state = await mkdtemp(join(tmpdir(), 'owned-service-live-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  // A registration naming a live process: the user's own OpenCode is running, and the rule is that it wins —
  // ours must not start on top of it, because starting ours is what reaps theirs.
  await mkdir(join(state, 'opencode'), { recursive: true });
  await writeFile(join(state, 'opencode', 'service.json'), JSON.stringify({ id: 'x', version: '2.0.28', url: 'http://127.0.0.1:49374', pid: process.pid, password: 'p' }));

  let started = 0;
  const stop = startOpencodeSupervisor({
    dataDir,
    intervalMs: 20,
    env: { ...process.env, OMNIHILBRAS_OPENCODE_SERVICE: 'auto', OMNIHILBRAS_OPENCODE_BINARY: process.execPath, XDG_STATE_HOME: state },
    ensure: async () => { started += 1; },
    log: () => {},
  });
  await wait(110);
  stop();
  assert.equal(started, 0, 'nothing was started while a service was live');
});

test('the supervisor does nothing at all when the runtime is switched off', async (t) => {
  const dataDir = await tempData(t);
  let started = 0;
  const stop = startOpencodeSupervisor({
    dataDir,
    intervalMs: 20,
    env: { ...process.env, OMNIHILBRAS_OPENCODE_SERVICE: 'off' },
    ensure: async () => { started += 1; },
    log: () => {},
  });
  await wait(100);
  stop();
  assert.equal(started, 0, '`off` means off');
});

/** A port nothing is listening on, taken by binding and releasing one. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('two concurrent starts spawn one instance, not two', async (t) => {
  /**
   * The race that left a running instance unowned. The route and the supervisor both start when nothing is
   * live; the loser cannot bind the port, exits, and — writing last — puts *its* pid in the pid file. Measured
   * on a real click: pid file `2188042`, the process listening `2188013`, `serviceOwned: false` for a service
   * that was running perfectly well.
   *
   * The binary is a stub that records each time it runs, so "how many spawns happened" is a fact rather than
   * an inference from the pid file.
   */
  const dataDir = await tempData(t);
  const dir = await mkdtemp(join(tmpdir(), 'owned-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = join(dir, 'spawns');
  const stub = join(dir, 'opencode-stub.sh');
  await writeFile(stub, `#!/bin/sh\necho start >> ${ledger}\nsleep 30\n`, { mode: 0o755 });
  const options = { dataDir, env: { ...process.env, OMNIHILBRAS_OPENCODE_PORT: String(await freePort()) } };

  await Promise.all([startOpencodeService(stub, options), startOpencodeService(stub, options)]);
  await wait(500);

  const spawns = (await readFile(ledger, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  assert.equal(spawns, 1, 'one spawn for two concurrent starts');

  // The stub is detached: it has to be killed by the pid the start recorded, which is also the record the
  // gateway would stop it by.
  const pid = Number.parseInt((await readFile(opencodeOwnServicePidFile(options), 'utf8').catch(() => '')).trim(), 10);
  if (Number.isInteger(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('nothing is started into a port that already answers', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const dataDir = await tempData(t);
  const emptyState = await mkdtemp(join(tmpdir(), 'owned-service-occupied-'));
  t.after(() => rm(emptyState, { recursive: true, force: true }));
  let started = 0;
  const options = {
    dataDir,
    env: { ...process.env, OMNIHILBRAS_OPENCODE_PORT: String(port), XDG_STATE_HOME: emptyState, OMNIHILBRAS_OPENCODE_BINARY: process.execPath },
    start: async () => { started += 1; },
  };

  const endpoint = await ensureOpencodeService(options);
  assert.equal(endpoint, undefined, 'it does not claim a service it did not find');
  assert.equal(started, 0, 'and it does not spawn one into an occupied port');
});

test('the status names a port that something else holds', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const dataDir = await tempData(t);
  const emptyState = await mkdtemp(join(tmpdir(), 'owned-service-status-'));
  t.after(() => rm(emptyState, { recursive: true, force: true }));
  const status = await opencodeRuntimeStatus({
    dataDir,
    env: { ...process.env, OMNIHILBRAS_OPENCODE_PORT: String(port), XDG_STATE_HOME: emptyState },
  });

  // Without this the panel says "installed, not running" for a busy port, which is what made Start service
  // look like a button that does nothing.
  assert.equal(status.serviceRunning, false);
  assert.equal(status.portOccupied, true);
  assert.match(status.message ?? '', /already answering/, 'and says so rather than leaving it to be guessed');
});
