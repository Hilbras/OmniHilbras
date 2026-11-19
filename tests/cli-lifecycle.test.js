import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundledRecordPath, readBundledRecord, writeBundledRecord, stopBundledServers, looksLikeOurServer } from '../cli/lib/bundled-state.mjs';
import { verbs } from '../cli/index.mjs';
import { bundledFacts } from '../cli/commands/doctor.mjs';

/**
 * Lifecycle control over the bundled run (3.75.0): `stop`, `restart`, `open`, `ps`.
 *
 * The end-to-end round-trip against a real launcher lives in `scripts/smoke-cli-server.mjs`, which runs after
 * the bundle is staged. These are the fast properties that must hold regardless: the ownership decision that
 * keeps `stop` from killing a reused pid, the single record path shared with the launcher, and the verbs being
 * registered with the flags they declare.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the record path is the one the launcher writes, under XDG_STATE_HOME', () => {
  assert.equal(bundledRecordPath({ XDG_STATE_HOME: '/tmp/state' }), path.join('/tmp/state', 'omnihilbras', 'bundled.json'));
  // The launcher must import the shared definition, not re-declare the path — that re-declaration is the drift
  // this module exists to prevent.
  const launcher = read('cli/server-src/main.mjs');
  assert.match(launcher, /from '\.\.\/lib\/bundled-state\.mjs'/, 'the launcher imports the shared bundled-state module');
  assert.doesNotMatch(launcher, /const STATE_DIR/, 'the launcher no longer re-declares the state directory');
  assert.doesNotMatch(launcher, /'\.local', 'state', 'omnihilbras'/, 'nor re-derives the fallback path inline');
});

test('a missing record reads as undefined, not an error', () => {
  assert.equal(readBundledRecord({ XDG_STATE_HOME: '/tmp/does-not-exist-omnihilbras' }), undefined);
});

test('only a command line naming our servers counts as ours', () => {
  assert.equal(looksLikeOurServer('node /home/u/.local/lib/node_modules/@hilbras/omnihilbras/cli/server/gateway.mjs'), true);
  assert.equal(looksLikeOurServer('node /x/cli/server/static.mjs'), true);
  assert.equal(looksLikeOurServer('node /usr/bin/some-other-app.js'), false);
  assert.equal(looksLikeOurServer(''), false);
  assert.equal(looksLikeOurServer(undefined), false);
});

/** Drives the stop decision with injected liveness/command-line/kill, so no real process is touched. */
function decide(record, { alivePids = [], lines = {}, force = false } = {}) {
  const killed = [];
  const result = stopBundledServers(record, {
    force,
    alive: (pid) => alivePids.includes(pid),
    commandLine: (pid) => lines[pid] ?? '',
    kill: (pid, signal) => killed.push([pid, signal]),
  });
  return { ...result, killed };
}

test('stop signals both servers when both are alive and ours', () => {
  const result = decide({ gatewayPid: 101, staticPid: 102 }, {
    alivePids: [101, 102],
    lines: { 101: 'node /x/gateway.mjs', 102: 'node /x/static.mjs' },
  });
  assert.deepEqual(result.stopped.sort(), [101, 102]);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.killed, [[101, 'SIGTERM'], [102, 'SIGTERM']]);
});

test('stop refuses a reused/foreign pid and leaves it alone', () => {
  const result = decide({ gatewayPid: 101, staticPid: 102 }, {
    alivePids: [101, 102],
    lines: { 101: 'node /x/gateway.mjs', 102: 'node /usr/bin/postgres' },
  });
  assert.deepEqual(result.stopped, [101]);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].pid, 102);
  assert.deepEqual(result.killed, [[101, 'SIGTERM']], 'the foreign pid was never signalled');
});

test('force is the explicit override for a pid that cannot be attributed', () => {
  const result = decide({ gatewayPid: 101, staticPid: 102 }, {
    alivePids: [101, 102],
    lines: { 101: 'node /x/gateway.mjs', 102: 'node /usr/bin/postgres' },
    force: true,
  });
  assert.deepEqual(result.stopped.sort(), [101, 102]);
  assert.deepEqual(result.refused, []);
});

test('a pid that is already dead is reported gone, not signalled', () => {
  const result = decide({ gatewayPid: 101, staticPid: 102 }, {
    alivePids: [101],
    lines: { 101: 'node /x/gateway.mjs' },
  });
  assert.deepEqual(result.stopped, [101]);
  assert.deepEqual(result.gone, [102]);
  assert.deepEqual(result.killed, [[101, 'SIGTERM']]);
});

test('the lifecycle verbs are registered with the flags they accept', () => {
  for (const name of ['stop', 'restart', 'open', 'ps']) {
    assert.ok(verbs[name], `verb ${name} is registered`);
    assert.equal(verbs[name].name, name);
    assert.match(verbs[name].usage, /^omnihilbras /);
    assert.ok(Array.isArray(verbs[name].flags));
  }
  assert.deepEqual(verbs.stop.flags, ['--force']);
  assert.deepEqual(verbs.restart.flags, ['--force']);
  assert.deepEqual(verbs.open.flags, []);
  assert.deepEqual(verbs.ps.flags, []);
});

test('doctor bundledFacts reports an empty installation truthfully', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-doctor-'));
  try {
    const env = { XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state'), OMNIHILBRAS_BUNDLED_SERVER: path.join(dir, 'no-server.mjs') };
    const facts = bundledFacts(env);
    assert.equal(facts.present, false, 'no bundled server staged');
    assert.equal(facts.tokenPresent, false, 'no gateway has run');
    assert.equal(facts.run, null, 'no run recorded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor bundledFacts sees a staged server, a token, and a recorded run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-doctor-'));
  try {
    const serverFile = path.join(dir, 'main.mjs');
    fs.writeFileSync(serverFile, '// stand-in\n');
    const env = { XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state'), OMNIHILBRAS_BUNDLED_SERVER: serverFile };
    fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'omnihilbras'), { recursive: true });
    fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'omnihilbras', 'dashboard-token'), 'a-token\n');
    // A record whose pids are not alive: doctor must report the run but not claim it is up.
    writeBundledRecord({ gatewayPid: 999999, staticPid: 999998, dashboardPort: 20137, gatewayPort: 20138, startedAt: new Date().toISOString() }, env);
    const facts = bundledFacts(env);
    assert.equal(facts.present, true);
    assert.equal(facts.tokenPresent, true);
    assert.equal(facts.run.dashboardPort, 20137);
    assert.equal(facts.run.gatewayAlive, false);
    assert.equal(facts.run.dashboardAlive, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
