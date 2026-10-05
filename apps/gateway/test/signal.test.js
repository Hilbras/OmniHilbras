import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
// Fixed in `main.ts`. The residual window is Node's ESM module loading — measured per run, and over 1.6 s under suite load, for this
// import graph — which no in-process code can cover. That is why the "during startup" test asserts the
// graceful outcome at a delay chosen to be *inside* the module-loading window but *after* the entry
// module's own statements would run, rather than pretending the window is gone.

// `test/` -> `..` is apps/gateway. `../..` is `apps`, which put the entry point at
// `apps/dist/main.js` — a path that does not exist, and every test then failed on
// "never listened" with no mention of the missing file. Asserted below so it cannot recur.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'dist/main.js');
/**
 * The graph whose load time is the residual SIGTERM window, named once so the probe and the assertion
 * below cannot drift onto different modules. `main.js` imports `server.js`, so timing `main.js` measures
 * the larger graph — but the bounded test imports `server.js` directly, and a delay derived from one
 * graph is only safe if it exceeds the other, which is a claim about two files rather than one.
 */
const SERVER_MODULE = join(ROOT, 'dist/server.js');

test('the gateway entry point this suite signals actually exists', () => {
  // These tests spawn a real process. If the path is wrong they all fail identically and misleadingly —
  // four "never listened" timeouts, which reads like a shutdown bug and is not one.
  assert.ok(existsSync(ENTRY), `${ENTRY} does not exist; the signal tests would all fail for the wrong reason`);
  assert.ok(ENTRY.endsWith('/dist/main.js'), `unexpected entry point: ${ENTRY}`);
});

/**
 * How long this build takes to load its module graph.
 *
 * **Measured, not declared.** This used to be `1_200`, hand-written next to a comment claiming it had been
 * "measured once and reused" — and it was wrong. Measured now: 254 ms unloaded, and **1615 ms under the CPU
 * contention of a full gateway suite**, which is what runs when `pnpm test` executes this file alongside 490
 * other tests. So the delay was inside the module-loading window about half the time, the signal took Node's
 * default disposition, and the test failed for a reason that has nothing to do with shutdown.
 *
 * It failed once, in a full-suite run, and passed 3/3 in isolation — the exact signature of a clock race, and
 * the reason to measure rather than pick a number large enough to have worked yesterday.
 *
 * The probe imports the entry the same way Node does, so it measures the same graph, and the caller doubles
 * it: a factor is honest about the fact that this is a race, while a fixed constant is a claim that it is not.
 */
function measureModuleLoadMs() {
  // The graph this has to cover is the **server** module, because that is what the bounded test below
  // times (`import(dist/server.js)`), and the invariant it checks is `delay > elapsed`. Comparing a
  // probe of `main.js` against a measurement of `server.js` compares two different import graphs, and
  // two independently-sampled clocks — which is how the suite failed on a loaded machine: the probe
  // read 305 ms for `main.js` while the in-process import of `server.js` took 1045 ms, and the delay
  // derived from the first (860 ms) was legitimately below the second.
  //
  // So: same module, and the worst of several samples rather than one. A single sample of a loaded
  // machine is noise; the max of three is a bound, which is what a signal delay has to be.
  const samples = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const probe = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const t = Date.now();
        await import(${JSON.stringify(SERVER_MODULE)}).catch(() => {});
        process.stdout.write(String(Date.now() - t));`],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, OMNIHILBRAS_PORT: '0' } },
    );
    const measured = Number.parseInt(probe.stdout ?? '', 10);
    if (Number.isFinite(measured) && measured > 0) samples.push(measured);
  }
  // A probe that failed to measure must not silently become 0, which would restore the race this replaces.
  if (samples.length === 0) return 1_200;
  return Math.max(...samples);
}

let cachedModuleLoadMs = null;
function moduleLoadMs() {
  cachedModuleLoadMs ??= measureModuleLoadMs();
  return cachedModuleLoadMs;
}

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
  // It does **not** control Node's ESM module loading, measured per run for this import graph. A
  // signal inside that window still gets Node's default disposition, and no in-process code can change
  // that — only a `--import` preload, which is a packaging decision rather than a code fix.
  //
  // So this test waits for the *process to exist and be past module load*, rather than for "listening",
  // and then sends the signal. It is the boundary the fix owns, and it is asserted against the measured
  // load time rather than a guessed delay.
  const child = launch(8943);
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => setTimeout(resolve, moduleLoadMs() * 2 + 250));

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
  // Inside the ESM module-loading window SIGTERM gets Node's default disposition, and the process cannot say
  // anything about it because none of its code has run. This test exists so the number cannot silently grow:
  // a heavier import graph widens the window in which an orchestrator's SIGTERM is a hard kill.
  const serverModule = SERVER_MODULE;
  assert.ok(existsSync(serverModule), `${serverModule} is missing`);

  const started = Date.now();
  return import(pathToFileURL(serverModule).href).then(() => {
    const elapsed = Date.now() - started;
    // 4 s is roughly five times the measured load. Generous enough not to flake on a loaded CI runner,
    // tight enough that a genuine regression in import weight is noticed.
    assert.ok(elapsed < 4_000, `the gateway's import graph took ${elapsed}ms to load, widening the window in which SIGTERM is a hard kill`);

    // The startup delay is derived from a measurement, so the invariant is now that the derived delay
    // **exceeds** the elapsed time here — not that a hand-written constant does. The old assertion was
    // `MODULE_LOAD_MS > elapsed`, which only held because the constant was picked large enough to satisfy
    // it; under suite load the real graph took 1615 ms and 1200 did not, which is how that test failed in
    // a full run while passing in isolation.
    //
    // Both sides must be the same module on the same clock. The probe in `measureModuleLoadMs` now times
    // `server.js` in a fresh process and takes the worst of three samples; this `elapsed` is a warm
    // in-process import, which is *faster*, so the derived delay is an upper bound on it and the
    // comparison holds. It compared a cold `main.js` probe against this warm `server.js` import before,
    // which is why a loaded runner produced 860 ms < 1045 ms.
    const delay = moduleLoadMs() * 2 + 250;
    assert.ok(
      delay > elapsed,
      `the startup delay (${delay}ms) must exceed the measured load time (${elapsed}ms), or the startup ` +
        'test signals inside the window it claims to avoid',
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
