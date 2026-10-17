import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The `omnihilbras` launcher.
 *
 * These tests deliberately only exercise paths that exit before anything is started or stopped.
 * The start path needs two servers and the ownership check needs real process groups, and a test that
 * ran either would stop the developer's running dashboard — which is the exact thing this launcher
 * exists to avoid. The two properties that *would* have that power are checked by reading the source
 * instead: what it records, and what it is willing to signal.
 */

const ROOT = new URL('..', import.meta.url);
const LAUNCHER = fileURLToPath(new URL('bin/omnihilbras.js', ROOT));
const source = readFileSync(LAUNCHER, 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));

const run = (...args) => spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8' });

test('the command is declared, present, and executable', () => {
  assert.equal(pkg.bin?.omnihilbras, './bin/omnihilbras.js', 'the launcher is not registered as a command');
  assert.ok(existsSync(LAUNCHER), 'the launcher file is missing');
  // A `bin` npm links is run directly, so a missing exec bit is a command that fails with EACCES.
  assert.ok(statSync(LAUNCHER).mode & 0o111, 'the launcher is not executable, so npm link gives a command that cannot run');
});

test('it reports the version the repository is at', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version, 'the launcher reports a version the package does not claim');
});

test('the help states what it starts and how to move the ports', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  for (const expected of ['--port', '--gateway-port', 'dashboard', 'gateway', 'Ctrl-C']) {
    assert.match(result.stdout, new RegExp(expected.replace('-', '\\-')), `the help does not mention ${expected}`);
  }
});

test('a bad option is refused rather than ignored', () => {
  // Silently ignoring an unknown flag is how a launcher ends up on a port nobody asked for.
  const result = run('--not-a-flag');
  assert.notEqual(result.status, 0, 'an unknown option was accepted');
  assert.match(result.stderr, /Unknown option/, 'the refusal does not say what was wrong');
});

test('a port option with no value is refused, not read as NaN', () => {
  const result = run('--port');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs a value/);
});

test('a port that is not a number is refused', () => {
  for (const bad of ['abc', '0', '70000', '-1']) {
    const result = run('--port', bad);
    assert.notEqual(result.status, 0, `"${bad}" was accepted as a port`);
    assert.match(result.stderr, /port number|must be a port/i);
  }
});

test('the two servers cannot be told to share a port', () => {
  const result = run('--port', '6000', '--gateway-port', '6000');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot share a port/);
});

test('it records process groups, because the listening process is not the one it spawns', () => {
  // `pnpm` is what gets spawned; the server that binds the port is its child. Recording only the
  // spawned pid is what made a restart leave the previous run holding the ports.
  assert.match(source, /detached: true/, 'the children are not spawned detached, so a group id means nothing');
  assert.match(source, /gatewayGroup: gateway\.pid/, 'the gateway is not recorded as a process group');
  assert.match(source, /dashboardGroup: dashboard\.pid/, 'the dashboard is not recorded as a process group');
  assert.doesNotMatch(source, /gatewayPid:|dashboardPid:/, 'a bare pid is recorded alongside the group, which is what went stale');
});

test('it signals a group only after checking the group is still its own', () => {
  // The dangerous operation is `kill(-pid)`. Unguarded, a recycled group id takes down whatever
  // inherited it, so the ownership check has to be the gate rather than a comment.
  assert.match(source, /function groupIsOurs\(/, 'there is no ownership check before signalling a group');
  const guardedSignal = /if \(!groupIsOurs\(pgid\)\) continue;/.test(source);
  assert.ok(guardedSignal, 'a recorded group is signalled without first proving it is ours');
  // And the shutdown path must go through the same helper, not a raw process.kill.
  assert.doesNotMatch(source, /process\.kill\(-child\.pid/, 'shutdown signals a group directly, bypassing the helper');
});

test('a port is checked before the previous run is stopped', () => {
  // Order is the whole point: a typo in a port must not cost the developer a running server. Read
  // as source because the property *is* the sequence, which no single run can demonstrate.
  const check = source.indexOf('is already in use');
  // The call site, not the definition — `function stopPreviousRun()` contains the same substring and
  // sits above the check, which would make this assertion pass for the wrong reason.
  const stop = source.indexOf('const stopped = stopPreviousRun()');
  assert.ok(check > 0 && stop > 0, 'either the refusal or the stop is missing');
  assert.ok(check < stop, 'the previous run is stopped before a foreign port is refused');
});

test('it uses no dependencies, so the launcher cannot fail on a missing install', () => {
  // Everything it needs is in `node:`; a launcher that imports a package is a launcher that breaks
  // when the install is the thing that is broken.
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  assert.ok(imports.length > 0, 'the launcher imports nothing at all, which is suspicious');
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
      `the launcher imports a package (${specifier}); it must depend on nothing but node builtins`);
  }
  assert.doesNotMatch(source, /^const .* = require\(/m, 'the launcher mixes CommonJS into an ES module');
  // The one `require` it does contain is inside the script string for a child process, which runs as
  // CommonJS regardless of this file's module system. That is the child speaking, not the launcher.
  const requireLines = source.split('\n').filter((line) => line.includes('require('));
  for (const line of requireLines) {
    assert.match(line, /node -e|const net = require|^\s*const net/,
      `the launcher calls require() outside a child-process script string: ${line.trim()}`);
  }
});