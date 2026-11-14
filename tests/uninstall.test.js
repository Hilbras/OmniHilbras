import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The uninstaller, run for real — against a fake home, so the assertions are about **deletion** and can be
 * checked instead of trusted.
 *
 * This is destructive code, and the two things it must never do are the two that are easiest to get wrong:
 * remove something it only intended to list (`--dry-run`), and remove the vault when it was not asked to.
 * Both are asserted below on a real filesystem with real directories, because a mocked `rm` would test the
 * mock.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'uninstall', 'unix.sh');

/** A home with an installation in it, and a fake npm that reports the old published version. */
async function fakeMachine(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'uninstall-home-'));
  const bin = await mkdtemp(path.join(tmpdir(), 'uninstall-bin-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(bin, { recursive: true, force: true })]));

  // The layout the script is expected to find: an app directory, a leftover binary on PATH, the vault and
  // the config directory.
  await mkdir(path.join(home, 'app'), { recursive: true });
  await writeFile(path.join(home, 'app', 'OmniHilbras'), 'binary\n');
  await writeFile(path.join(bin, 'omnihilbras'), '#!/usr/bin/env node\n');
  await chmod(path.join(bin, 'omnihilbras'), 0o755);
  await mkdir(path.join(home, '.omnihilbras'), { recursive: true });
  await writeFile(path.join(home, '.omnihilbras', 'vault.json'), '{"credentials":[]}\n');
  await mkdir(path.join(home, '.config', 'omnihilbras'), { recursive: true });
  await writeFile(path.join(home, '.config', 'omnihilbras', 'connections.json'), '{}\n');

  const toolbox = await makeToolbox(bin);

  // A fake npm: `ls -g --json` reports the old package, `prefix -g` reports a global bin directory, and
  // `rm -g` records what it was asked to remove so the test can see it happened.
  const npmLog = path.join(home, 'npm-calls.log');
  await writeFile(path.join(bin, 'npm'), `#!/usr/bin/env bash
echo "npm $*" >> ${JSON.stringify(npmLog)}
if [ "$1" = "ls" ]; then
  printf '%s\\n' '{"dependencies":{"@hilbras/omnihilbras":{"version":"2.9.18"}}}'
  exit 0
fi
if [ "$1" = "prefix" ]; then echo ${JSON.stringify(bin)}; exit 0; fi
if [ "$1" = "--version" ]; then echo 11.20.0; exit 0; fi
exit 0
`);
  await chmod(path.join(bin, 'npm'), 0o755);

  return { home, bin, npmLog, toolbox };
}


/** Where a real command lives, resolved before PATH is narrowed to the fake machine. */
function spawnSyncTool(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}


/**
 * A directory holding only the commands the script uses, symlinked from the real ones.
 *
 * PATH is then the fake bin directory plus this, and **not** the system directories — because this machine
 * really does have `/usr/bin/omnihilbras` and `/bin/omnihilbras` left by an older install, and a test that
 * can see them is asserting about this machine rather than about the script.
 */
async function makeToolbox(binDir) {
  const toolbox = path.join(binDir, '.toolbox');
  await mkdir(toolbox, { recursive: true });
  for (const tool of ['grep', 'sed', 'rm', 'pgrep', 'head', 'cut', 'tr', 'cat', 'ls', 'dirname', 'bash']) {
    const resolved = spawnSyncTool(tool);
    if (resolved) await symlink(resolved, path.join(toolbox, tool));
  }
  return toolbox;
}

function runUninstall(args, machine) {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], {
      env: {
        ...process.env,
        HOME: machine.home,
        XDG_CONFIG_HOME: path.join(machine.home, '.config'),
        XDG_STATE_HOME: path.join(machine.home, '.local', 'state'),
        XDG_DATA_HOME: path.join(machine.home, '.local', 'share'),
        // The fake bin first, so `command -v npm` finds it; the real PATH after, for rm/grep/sed.
        PATH: `${machine.bin}${path.delimiter}${machine.toolbox}`,
        NO_COLOR: '1',
        // The test machine may genuinely have /opt/OmniHilbras (this one does), which needs root to remove
        // and would turn every assertion about the fake home into an assertion about /opt. The switch
        // exists for exactly that: it is what a user-scope uninstall wants anyway.
        OMNIHILBRAS_UNINSTALL_SKIP_SYSTEM: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const exists = (candidate) => fs.existsSync(candidate);

test('--dry-run lists everything and removes nothing', async (t) => {
  const machine = await fakeMachine(t);
  const { code, stdout } = await runUninstall(['--dry-run'], machine);

  assert.equal(code, 0);
  assert.match(stdout, /@hilbras\/omnihilbras 2\.9\.18/, 'it found the old published version');
  assert.match(stdout, new RegExp(path.join(machine.bin, 'omnihilbras').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and the leftover binary on PATH');

  // The point of the flag: this is the run a cautious person does first.
  assert.equal(exists(path.join(machine.bin, 'omnihilbras')), true, 'the binary is still there');
  assert.equal(exists(path.join(machine.home, '.omnihilbras', 'vault.json')), true, 'the vault is still there');
  assert.equal(fs.readFileSync(machine.npmLog, 'utf8').includes('npm rm'), false, 'npm removed nothing');
});

test('a confirmed run removes the install and keeps the vault', async (t) => {
  const machine = await fakeMachine(t);
  const { code, stdout } = await runUninstall(['--yes'], machine);

  assert.equal(code, 0);
  assert.equal(fs.readFileSync(machine.npmLog, 'utf8').includes('npm rm -g @hilbras/omnihilbras'), true, 'the package was removed');
  assert.equal(exists(path.join(machine.bin, 'omnihilbras')), false, 'the leftover binary is gone');

  // Kept on purpose: the vault holds credentials, and an uninstall is not a reason to lose them.
  assert.equal(exists(path.join(machine.home, '.omnihilbras', 'vault.json')), true, 'the vault survives');
  assert.equal(exists(path.join(machine.home, '.config', 'omnihilbras', 'connections.json')), true, 'so does the configuration');
  assert.match(stdout, /kept/, 'and the output says so');
});

test('--purge-data removes the vault, and says what that costs', async (t) => {
  const machine = await fakeMachine(t);
  const { code, stdout } = await runUninstall(['--yes', '--purge-data'], machine);

  assert.equal(code, 0);
  assert.equal(exists(path.join(machine.home, '.omnihilbras')), false, 'the vault directory is gone');
  assert.equal(exists(path.join(machine.home, '.config', 'omnihilbras')), false, 'and the configuration');
  assert.match(stdout, /every saved provider credential/, 'and it warned before doing it');
});

test('without a terminal it refuses to guess, and removes nothing', async (t) => {
  const machine = await fakeMachine(t);
  // No --yes and stdin is not a terminal, which is the shape of a script that forgot the flag.
  const { code, stdout } = await runUninstall([], machine);

  assert.equal(code, 0);
  assert.match(stdout, /No terminal to confirm on/);
  assert.equal(exists(path.join(machine.bin, 'omnihilbras')), true, 'nothing was removed');
  assert.equal(exists(path.join(machine.home, '.omnihilbras', 'vault.json')), true, 'and the vault is untouched');
});

test('no installation means no work and a zero exit', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'uninstall-empty-'));
  const bin = await mkdtemp(path.join(tmpdir(), 'uninstall-empty-bin-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(bin, { recursive: true, force: true })]));

  const toolbox = await makeToolbox(bin);
  const { code, stdout } = await runUninstall(['--dry-run'], { home, bin, toolbox, npmLog: path.join(home, 'npm-calls.log') });
  assert.equal(code, 0);
  assert.match(stdout, /Nothing to remove/);
});

test('an unknown flag is refused rather than ignored', async (t) => {
  const machine = await fakeMachine(t);
  // A mistyped destructive flag must not be treated as "no flags": silently ignoring `--purge-dta` would
  // run the uninstall the person was trying to be careful about.
  const { code, stderr } = await runUninstall(['--purge-dta'], machine);
  assert.equal(code, 2, 'the usage exit code');
  assert.match(stderr, /Unknown option/);
});

test('the uninstaller does not match unrelated processes as running servers', async (t) => {
  const machine = await fakeMachine(t);
  const { stdout } = await runUninstall(['--dry-run'], machine);
  // The pattern used to be the bare word `omnihilbras`, which matched every process started from a
  // checkout whose path contains OmniHilbras — browsers and shells included.
  const running = stdout.split('Checking for running processes')[1] ?? '';
  assert.equal(/chrome|headless/i.test(running), false, 'no browser is reported as a running server');
});

test('a dry run cannot reach any removal code', async () => {
  /**
   * The bug this pins, made while editing this script: a slice removed the dry-run early exit, and the
   * dry run then walked into the removal section. It happened to be harmless that time — every removal is
   * behind its own `DRY_RUN` check — but "happened to be harmless" is not a property, and a `--dry-run`
   * that deletes is the worst thing this file could do.
   *
   * Asserted on the source rather than by running it, because a behavioural test can only prove that a
   * *particular* removal did not happen, while this proves none of them can be reached.
   */
  const source = fs.readFileSync(script, 'utf8');
  const exitAt = source.indexOf('Dry run — nothing was removed');
  assert.ok(exitAt > 0, 'the dry-run exit still exists');

  // The executable forms, not the words: `npm rm -g` also appears in this script's own header comment,
  // which is above the dry-run exit and made the first version of this test fail for the wrong reason.
  for (const marker of ['step "Removing"', 'if npm rm -g "$name"', 'update-alternatives --remove omnihilbras', 'remove_path "$dir"']) {
    const at = source.indexOf(marker);
    assert.ok(at > exitAt, `${marker} must come after the dry-run exit`);
  }

  // And the exit has to be an exit, not a note printed on the way past.
  const after = source.slice(exitAt, exitAt + 200);
  assert.match(after, /exit 0/, 'the dry-run branch actually stops');
});
