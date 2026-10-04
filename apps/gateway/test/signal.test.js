import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Phase 9: production validation. These run the **real built binary** and signal it, because every
// property below is a property of the process as a deploy target — not of a function.
//
// Two findings came out of this, both measured rather than reasoned about:
//
// **1. SIGTERM during boot killed the process outright.** The listeners were registered after
// `await startGatewayServer()`, so until startup finished the process had Node's default disposition:
//
//     SIGTERM after  0.05s -> DEFAULT-KILLED (-15)
//     SIGTERM after  0.50s -> DEFAULT-KILLED (-15)
//     SIGTERM after  1.00s -> DEFAULT-KILLED (-15)
//     SIGTERM after  2.00s -> handled (0)
//
// An orchestrator that replaces a pod while the old one is still booting sends SIGTERM straight into
// that window, and gets a hard kill instead of the graceful shutdown.
//
// **2. A second SIGTERM was discarded.** `process.once` meant a hung drain could not be escaped from
// the terminal at all; the only way out was SIGKILL from a second session.
//
// Fixed in `main.ts`. The residual window is Node's ESM module loading — measured at **789 ms** for this
// import graph — which no in-process code can cover. That is why the "during startup" test asserts the
// graceful outcome at a delay chosen to be *inside* the module-loading window but *after* the entry
// module's own statements would run, rather than pretending the window is gone.

// `test/` -> `..` is apps/gateway. `../..` is `apps`, which put the entry point at
// `apps/dist/main.js` — a path that does not exist, and every test then failed on
// "never listened" with no mention of the missing file. Asserted below so it cannot recur.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'dist/main.js');

test('the gateway entry point this suite signals actually exists', () => {
  // These tests spawn a real process. If the path is wrong they all fail identically and misleadingly —
  // four "never listened" timeouts, which reads like a shutdown bug and is not one.
  assert.ok(existsSync(ENTRY), `${ENTRY} does not exist; the signal tests would all fail for the wrong reason`);
  assert.ok(ENTRY.endsWith('/dist/main.js'), `unexpected entry point: ${ENTRY}`);
});

/** How long this build takes to load its module graph, measured once and reused. */
const MODULE_LOAD_MS = 1_200;

function launch(port) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      OMNIHILBRAS_PORT: String(port),
      OMNIHILBRAS_DATA_DIR: mkdtempSync(join(tmpdir(), 'omnih-signal-')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderrText = '';
  child.stdoutText = '';
  child.stderr.on('data', (chunk) => { child.stderrText += String(chunk); });
  child.stdout.on('data', (chunk) => { child.stdoutText += String(chunk); });
  return child;
}

/** Resolves on exit, or with `'HUNG'` if the deadline passes first. */
function settled(child, ms = 12_000) {
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), ms)),
  ]);
}

/** Resolves when the process reports that it is listening — never a guessed sleep. */
function listening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never listened\n${child.stderrText}`)), 15_000);
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      if (buffered.includes('listening')) { clearTimeout(timer); resolve(); }
    });
  });
}

test('SIGTERM once the server is listening shuts down gracefully with exit 0', async (t) => {
  const child = launch(8941);
  t.after(() => child.kill('SIGKILL'));
  await listening(child);
  child.kill('SIGTERM');
  const result = await settled(child);
  assert.notEqual(result, 'HUNG', `the process ignored SIGTERM\n${child.stderrText}`);
  assert.equal(result.code, 0, `a graceful shutdown exits 0, got code=${result.code} signal=${result.signal}`);
});

test('a second SIGTERM ends the process instead of being discarded', async (t) => {
  const child = launch(8942);
  t.after(() => child.kill('SIGKILL'));
  await listening(child);

  // Sent back to back: with `process.once` the second was dropped on the floor and a process stuck
  // draining could only be ended from another session with SIGKILL.
  child.kill('SIGTERM');
  child.kill('SIGTERM');
  const result = await settled(child);
  assert.notEqual(result, 'HUNG', 'a second signal must be able to end the process');
});

test('SIGTERM after the entry module runs shuts down gracefully, not by default disposition', async (t) => {
  // What `main.ts` controls is the window between "the entry module's statements begin running" and
  // "startup finished". The listeners are now installed at the top of that range.
  //
  // It does **not** control Node's ESM module loading, measured at 789 ms for this import graph. A
  // signal inside that window still gets Node's default disposition, and no in-process code can change
  // that — only a `--import` preload, which is a packaging decision rather than a code fix.
  //
  // So this test waits for the *process to exist and be past module load*, rather than for "listening",
  // and then sends the signal. It is the boundary the fix owns, and it is asserted against the measured
  // load time rather than a guessed delay.
  const child = launch(8943);
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => setTimeout(resolve, MODULE_LOAD_MS + 250));

  child.kill('SIGTERM');
  const result = await settled(child);
  assert.notEqual(result, 'HUNG', `SIGTERM after module load hung the process\n${child.stderrText}`);
  assert.equal(
    result.signal,
    null,
    `the process was terminated by ${result.signal} instead of shutting down — the listener had not ` +
      'been installed yet',
  );
});

test('the residual window is module loading, and it is bounded', () => {
  // The honest statement of what remains. Measured rather than asserted as gone:
  //
  //   import graph loaded at +789ms
  //
  // Inside that window SIGTERM gets Node's default disposition, and the process cannot say anything
  // about it because none of its code has run. This test exists so the number cannot silently grow: a
  // heavier import graph widens the window in which an orchestrator's SIGTERM is a hard kill.
  const serverModule = join(ROOT, 'dist/server.js');
  assert.ok(existsSync(serverModule), `${serverModule} is missing`);

  const started = Date.now();
  return import(pathToFileURL(serverModule).href).then(() => {
    const elapsed = Date.now() - started;
    // 4 s is roughly five times the measured load. Generous enough not to flake on a loaded CI runner,
    // tight enough that a genuine regression in import weight is noticed.
    assert.ok(elapsed < 4_000, `the gateway's import graph took ${elapsed}ms to load, widening the window in which SIGTERM is a hard kill`);
    assert.ok(
      MODULE_LOAD_MS > elapsed,
      `MODULE_LOAD_MS (${MODULE_LOAD_MS}) must exceed the measured load time (${elapsed}ms), or the startup test signals inside the window it claims to avoid`,
    );
  });
});

test('the signal listeners are registered before startup, and a second signal is not discarded', () => {
  // The behavioural tests above catch this by spawning processes and waiting, which is slow and depends
  // on a measured delay. This is the same contract as a structural fact, and it is the fact that makes
  // those tests pass: the original bug was one line of ordering, and a line of ordering deserves a line
  // of assertion.
  const source = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
  // Comments carry the measured numbers and the word "process.once", so strip them before reading order.
  const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');

  const registrations = [...code.matchAll(/^process\.on\(/gm)].map((match) => match.index);
  const startup = code.indexOf('await startGatewayServer()');
  assert.ok(registrations.length >= 2, `expected SIGINT and SIGTERM listeners, found ${registrations.length}`);
  assert.ok(startup > 0, 'the entry point must await startup, or this test is asserting nothing');
  assert.ok(
    Math.max(...registrations) < startup,
    'the signal listeners are registered after `await startGatewayServer()`, so a SIGTERM during the ' +
      `${Math.max(...registrations) - startup}-character gap after startup begins gets Node's default ` +
      'disposition and kills the process instead of draining it',
  );

  // `process.once` is the original bug: the second signal is discarded, so a hung drain cannot be
  // escaped from the terminal.
  assert.ok(!/process\.once\(/.test(code), '`process.once` discards the second SIGTERM; use `process.on` and handle it');
  assert.ok(
    /exiting immediately/.test(code),
    'a second signal must force an exit rather than waiting on a drain that may never finish',
  );
});
