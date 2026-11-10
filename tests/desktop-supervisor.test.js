import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewaySupervisor } from '../desktop/supervisor.mjs';

/**
 * The desktop supervisor, against a real child process.
 *
 * The app's first failure is always the same shape: a window that says "starting" forever, or a quit
 * that leaves a port held. These tests use a fixture that behaves like the gateway — a health route,
 * stdout, and SIGTERM — because a mocked spawn would prove only that the mock was called.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(ROOT, 'tests/support/fake-gateway.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function supervisorFor(port, overrides = {}) {
  return createGatewaySupervisor({
    projectRoot: ROOT,
    entry: FIXTURE,
    host: '127.0.0.1',
    port,
    readinessTimeoutMs: 8_000,
    readinessPollMs: 50,
    ...overrides,
  });
}

test('start reaches running, captures stdout, and stop releases the port', async () => {
  const port = await freePort();
  const supervisor = supervisorFor(port);
  try {
    const state = await supervisor.start();
    assert.equal(state.state, 'running');
    assert.ok(state.pid > 0);
    assert.equal(supervisor.logs.some((entry) => entry.stream === 'stdout' && /fake gateway ready/.test(entry.line)), true, 'stdout was not captured');

    await supervisor.stop();
    assert.equal(supervisor.state, 'stopped');
    // The next start on the same port proves the listener is gone.
    await supervisor.start();
    assert.equal(supervisor.state, 'running');
  } finally {
    await supervisor.stop();
  }
});

test('a port already in use fails before anything is spawned', async () => {
  const port = await freePort();
  const holder = createServer();
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(port, '127.0.0.1', resolve);
  });
  const supervisor = supervisorFor(port);
  try {
    await assert.rejects(() => supervisor.start(), /already in use/i);
    assert.equal(supervisor.state, 'failed');
    assert.match(supervisor.lastError, /already in use/i);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('a child that never answers /health is stopped and reported as a failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-supervisor-'));
  const silent = join(directory, 'silent.mjs');
  await writeFile(silent, "console.log('started, never listens'); setInterval(() => {}, 1000);\n");
  const port = await freePort();
  const supervisor = supervisorFor(port, { entry: silent, readinessTimeoutMs: 400, readinessPollMs: 50 });
  try {
    await assert.rejects(() => supervisor.start(), /did not answer/i);
    assert.equal(supervisor.state, 'failed');
    assert.equal(supervisor.child, undefined, 'the unready child was left running');
  } finally {
    await supervisor.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a busy preferred port falls back instead of refusing to open the app', async () => {
  const preferred = await freePort();
  const holder = createServer();
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(preferred, '127.0.0.1', resolve);
  });
  const supervisor = supervisorFor(preferred, { fallbackToFreePort: true });
  try {
    const state = await supervisor.start();
    assert.equal(state.state, 'running');
    assert.notEqual(state.port, preferred, 'the app stayed on the occupied port');
    assert.equal(state.port, supervisor.port);
  } finally {
    await supervisor.stop();
    await new Promise((resolve) => holder.close(resolve));
  }
});

test('an unexpected exit is restarted with backoff', async () => {
  const port = await freePort();
  const supervisor = supervisorFor(port, {
    autoRestart: true,
    maxRestarts: 2,
    restartBackoffMs: [50],
    env: { FAKE_CRASH_AFTER_MS: '150' },
  });
  try {
    await supervisor.start();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (supervisor.restarts >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(supervisor.restarts >= 1, 'the gateway was not restarted');
    assert.ok(['running', 'starting', 'restarting'].includes(supervisor.state), `unexpected state ${supervisor.state}`);
    assert.match(supervisor.logs.map((entry) => entry.line).join('\n'), /Restarting in/);
  } finally {
    await supervisor.stop();
  }
});

test('server output is persisted to the log file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-log-'));
  const logFile = join(directory, 'gateway.log');
  const port = await freePort();
  const supervisor = supervisorFor(port, { logFile });
  try {
    await supervisor.start();
    const content = await readFile(logFile, 'utf8');
    assert.match(content, /\[stdout\] fake gateway ready/, 'the gateway output never reached the file');
  } finally {
    await supervisor.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restart attempts stop at the configured limit', async () => {  const port = await freePort();
  const supervisor = supervisorFor(port, {
    autoRestart: true,
    maxRestarts: 1,
    restartBackoffMs: [20],
    env: { FAKE_CRASH_AFTER_MS: '80' },
  });
  try {
    await supervisor.start();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && supervisor.state !== 'failed') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(supervisor.state, 'failed');
    assert.match(supervisor.lastError, /Restart limit reached/);
  } finally {
    await supervisor.stop();
  }
});

test('restart stops the old process and starts a new one', async () => {
  const port = await freePort();
  const supervisor = supervisorFor(port);
  try {
    const first = await supervisor.start();
    const restarted = await supervisor.restart();
    assert.equal(restarted.state, 'running');
    assert.notEqual(restarted.pid, first.pid);
  } finally {
    await supervisor.stop();
  }
});

test('the log ring is bounded', async () => {
  const port = await freePort();
  const supervisor = supervisorFor(port, { logLines: 3 });
  try {
    await supervisor.start();
    for (let index = 0; index < 20; index += 1) supervisor.pushLog('stdout', `line ${index}\n`);
    assert.equal(supervisor.logs.length, 3);
    assert.equal(supervisor.logs.at(-1).line, 'line 19');
  } finally {
    await supervisor.stop();
  }
});
