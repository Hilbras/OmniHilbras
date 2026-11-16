import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { connect, createServer } from 'node:net';
import {
  ensureOpencodeService,
  opencodeOwnServiceConfigFile,
  opencodeOwnServiceEnv,
  opencodeOwnServiceFile,
  opencodeOwnServicePidFile,
  opencodeRuntimeStatus,
} from '../dist/src/core/opencode-runtime.js';

/**
 * The instance we started, alive with both of its records gone.
 *
 * Measured on this machine three times in one day, and each time the OpenCode-backed providers stayed down
 * until a person found the pid by hand:
 *
 * ```
 * an `opencode serve --service --port 49390` process is alive,
 *   its environment carries OUR XDG_CONFIG_HOME / XDG_STATE_HOME (so we spawned it),
 *   our pid file is gone, and its registration file in our state dir is gone too
 *
 * status: running false | owned false | portOccupied true
 * ...the most recent orphan had been alive 42 minutes, 38 of them before the current gateway started
 * ```
 *
 * Refusing that instance was right while it could not be identified and is the wrong answer now that it can:
 * `/proc` says a process is ours when its command line carries our markers **and** its environment carries
 * our own state directory, which is a pair the user's own OpenCode app does not produce. So the tests below
 * fabricate a process table rather than depending on which processes happen to run on the machine executing
 * the suite — `procRoot` is the injection point, and the real `/proc` is only the default.
 *
 * The other half is the boundary: a holder that is **not** ours must be refused with the same sentence it is
 * refused with today, and nothing is ever signalled. An instance that answers is an instance we can use.
 */

const tempData = async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orphan-adopt-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
};

/** An empty canonical state directory, so discovery cannot find the machine's real OpenCode. */
const emptyState = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orphan-adopt-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** The listener that stands in for the orphan: what matters to the guard is that the port answers. */
async function listen(t) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server;
}

/**
 * A fabricated `/proc`: one pid-shaped directory holding the two files the scan reads.
 *
 * `pid` is this test process, deliberately — a real pid, so an adopted entry is a live one, and the pid file
 * records a number that exists. Nothing in these tests signals it.
 */
async function fabricateProc(t, entries) {
  const procRoot = await mkdtemp(join(tmpdir(), 'orphan-adopt-proc-'));
  t.after(() => rm(procRoot, { recursive: true, force: true }));
  for (const [pid, entry] of Object.entries(entries)) {
    await mkdir(join(procRoot, pid), { recursive: true });
    await writeFile(join(procRoot, pid, 'cmdline'), entry.commandLine.join('\0'));
    await writeFile(join(procRoot, pid, 'environ'), entry.environment.join('\0'));
  }
  return procRoot;
}

/** The command line and environment our own spawn produces, so an entry can differ from it one way at a time. */
function ownProcessEntry({ port, stateHome, cmdlinePort = port, environStateHome = stateHome }) {
  return {
    commandLine: ['/home/someone/.opencode/bin/opencode', 'serve', '--service', '--port', String(cmdlinePort)],
    environment: ['PATH=/usr/bin', `XDG_STATE_HOME=${environStateHome}`, 'HOME=/home/someone'],
  };
}

async function optionsFor(t, { procRoot, port }) {
  return {
    dataDir: await tempData(t),
    env: {
      ...process.env,
      OMNIHILBRAS_OPENCODE_SERVICE: 'auto',
      OMNIHILBRAS_OPENCODE_PORT: String(port),
      XDG_STATE_HOME: await emptyState(t),
    },
    procRoot,
  };
}

test('a live listener and a process that is identifiably ours: adopted, recorded, reported as running and owned', async (t) => {
  const server = await listen(t);
  const port = server.address().port;
  const options = await optionsFor(t, { procRoot: '/proc', port });
  const stateHome = opencodeOwnServiceEnv({ dataDir: options.dataDir }).XDG_STATE_HOME;
  // The whole point: no registration in our directory, no pid file. Only the process is left.
  assert.equal(await readFile(opencodeOwnServiceFile(options), 'utf8').catch(() => undefined), undefined, 'nothing is registered');
  options.procRoot = await fabricateProc(t, { [process.pid]: ownProcessEntry({ port, stateHome }) });

  let started = 0;
  const endpoint = await ensureOpencodeService({ ...options, start: () => { started += 1; } });

  assert.equal(started, 0, 'nothing was spawned: the instance is already answering');
  assert.equal(endpoint?.url, `http://127.0.0.1:${port}`, 'the endpoint is built from the port we already know');
  const config = JSON.parse(await readFile(opencodeOwnServiceConfigFile(options), 'utf8'));
  assert.equal(endpoint?.password, config.password, 'and authenticates with our own config password');
  assert.equal(
    (await readFile(opencodeOwnServicePidFile(options), 'utf8')).trim(),
    String(process.pid),
    'the pid is written down, which is what makes it ours to stop later',
  );

  const status = await opencodeRuntimeStatus(options);
  assert.equal(status.serviceRunning, true, 'a service that answers is running');
  assert.equal(status.serviceOwned, true, 'and it is ours');
  assert.equal(status.serviceUrl, `http://127.0.0.1:${port}`);
  assert.equal(status.portOccupied, undefined, 'an adopted instance is used, not reported as a conflict');
  assert.equal(status.message, undefined, 'so there is nothing to act on');

  /**
   * Adoption is not a kill. Two halves, and the second is the sharper one: the listener that stands in for
   * the orphan is still accepting connections, and the pid written to the pid file is **this test process** —
   * so a `process.kill` anywhere in the adoption path would end the suite rather than fail an assertion. These
   * lines running at all is the evidence that nothing was signalled.
   */
  assert.equal(server.listening, true, 'the process was left alone');
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
});

test('a listener whose process does not carry our state directory: still refused, with today’s message', async (t) => {
  const server = await listen(t);
  const port = server.address().port;
  const options = await optionsFor(t, { procRoot: '/proc', port });
  // The user's own OpenCode app: the same binary, the same service flags, its own state directory.
  options.procRoot = await fabricateProc(t, {
    [process.pid]: ownProcessEntry({ port, stateHome: '/home/someone/.local/state' }),
  });

  let started = 0;
  const endpoint = await ensureOpencodeService({ ...options, start: () => { started += 1; } });
  assert.equal(endpoint, undefined, 'a process that is not ours is not answered for');

  const status = await opencodeRuntimeStatus(options);
  assert.equal(status.serviceRunning, false);
  assert.equal(status.serviceOwned, false);
  assert.equal(status.portOccupied, true);
  assert.match(status.message ?? '', /already answering/, 'the conflict is reported in the words it always was');
  assert.equal(
    await readFile(opencodeOwnServicePidFile(options), 'utf8').catch(() => undefined),
    undefined,
    'and nothing was recorded, because nothing was claimed',
  );
});

test('a command line for another port is not ours, even with our state directory in its environment', async (t) => {
  const server = await listen(t);
  const port = server.address().port;
  const options = await optionsFor(t, { procRoot: '/proc', port });
  const stateHome = opencodeOwnServiceEnv({ dataDir: options.dataDir }).XDG_STATE_HOME;
  // `--service` on the canonical port rather than ours: the marker that separates two instances of the same
  // binary. The environment is deliberately ours, so the port is the only thing excluding it.
  options.procRoot = await fabricateProc(t, {
    [process.pid]: ownProcessEntry({ port, stateHome, cmdlinePort: 49_374 }),
  });

  const endpoint = await ensureOpencodeService({ ...options, start: () => undefined });
  assert.equal(endpoint, undefined, 'a second instance on another port is somebody else’s');

  const status = await opencodeRuntimeStatus(options);
  assert.equal(status.serviceOwned, false);
  assert.equal(status.portOccupied, true);
  assert.equal(
    await readFile(opencodeOwnServicePidFile(options), 'utf8').catch(() => undefined),
    undefined,
    'nothing was recorded',
  );
});

test('a process table that cannot be read is not a guess: refused, no crash, nothing recorded', async (t) => {
  const server = await listen(t);
  const port = server.address().port;
  const options = await optionsFor(t, { procRoot: join(tmpdir(), 'orphan-adopt-no-such-proc'), port });

  const endpoint = await ensureOpencodeService({ ...options, start: () => undefined });
  assert.equal(endpoint, undefined, 'off Linux there is no /proc, and this is that path');

  const status = await opencodeRuntimeStatus(options);
  assert.equal(status.serviceOwned, false);
  assert.equal(status.portOccupied, true);
  assert.match(status.message ?? '', /already answering/, 'the conflict report is what remains');
  assert.equal(await readFile(opencodeOwnServicePidFile(options), 'utf8').catch(() => undefined), undefined);
});

test('a registration that exists and disagrees with us is not an orphan, however ours the process looks', async (t) => {
  /**
   * The boundary between the two ways something becomes ours, and the one that keeps this fix from turning a
   * hand-run instance into a killable one. A registration filed against the gateway's own paths names a live
   * process, and there is no pid file for it: the existing suite pins that as `owned: false`, and adoption
   * must not reach past it because the process it would otherwise pick matches on both halves.
   */
  const server = await listen(t);
  const port = server.address().port;
  const options = await optionsFor(t, { procRoot: '/proc', port });
  const stateHome = opencodeOwnServiceEnv({ dataDir: options.dataDir }).XDG_STATE_HOME;
  await mkdir(dirname(opencodeOwnServiceFile(options)), { recursive: true });
  await writeFile(opencodeOwnServiceFile(options), JSON.stringify({ id: 'x', version: '2.0.28', url: `http://127.0.0.1:${port}`, pid: process.pid, password: 'p' }));
  options.procRoot = await fabricateProc(t, { [process.pid]: ownProcessEntry({ port, stateHome }) });

  const status = await opencodeRuntimeStatus(options);
  assert.equal(status.serviceOwned, false, 'registered is still not the same as started by us');
  assert.equal(
    await readFile(opencodeOwnServicePidFile(options), 'utf8').catch(() => undefined),
    undefined,
    'and adoption did not write the record that would have made it ours',
  );
});
