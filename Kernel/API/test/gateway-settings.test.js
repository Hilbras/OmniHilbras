import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gatewayEnvFromSettings, gatewaySettingsPath } from '../dist/src/core/settings.js';

const ENTRY = fileURLToPath(new URL('../dist/src/main.js', import.meta.url));

/** A port the OS just said was free; the gateway refuses 0, so a test cannot ask for one. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * The persistent settings file.
 *
 * History trimming is the setting this exists for: a conversation that reaches the provider with
 * 850,000 tokens takes tens of seconds to prefill no matter how good the socket is, and an environment
 * variable set in one terminal does not survive the next launch. The file does.
 *
 * The rule these tests pin is the one that is easy to get wrong: an explicitly set environment variable
 * wins over the file, per key, so `OMNIHILBRAS_HISTORY_TRIM_TOKENS=50000 omnihilbras` is an override and
 * not a value the file quietly replaces.
 */

function homeWith(settings) {
  const root = mkdtempSync(join(tmpdir(), 'omnihilbras-settings-'));
  const dir = join(root, 'omnihilbras');
  mkdirSync(dir, { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return { root, file: join(dir, 'settings.json') };
}

test('the path is under the state directory the rest of the gateway uses', () => {
  assert.equal(gatewaySettingsPath({ XDG_CONFIG_HOME: '/tmp/example-config' }), '/tmp/example-config/omnihilbras/settings.json');
});

test('a missing file contributes nothing and says nothing', () => {
  const { root } = homeWith(undefined);
  const loaded = gatewayEnvFromSettings({ XDG_CONFIG_HOME: root });
  assert.deepEqual(loaded.env, {});
  assert.deepEqual(loaded.warnings, []);
});

test('history trimming is read and translated to the gateway variables', () => {
  const { root, file } = homeWith({ historyTrim: { maxInputTokens: 200_000, keepRecent: 8 } });
  const loaded = gatewayEnvFromSettings({ XDG_CONFIG_HOME: root });
  assert.equal(loaded.path, file);
  assert.deepEqual(loaded.env, {
    OMNIHILBRAS_HISTORY_TRIM_TOKENS: '200000',
    OMNIHILBRAS_HISTORY_TRIM_KEEP_RECENT: '8',
  });
  assert.deepEqual(loaded.warnings, []);
});

test('keepRecent is optional, because the gateway already has a default for it', () => {
  const { root } = homeWith({ historyTrim: { maxInputTokens: 128_000 } });
  assert.deepEqual(gatewayEnvFromSettings({ XDG_CONFIG_HOME: root }).env, { OMNIHILBRAS_HISTORY_TRIM_TOKENS: '128000' });
});

test('an explicit environment variable wins over the file, per key', () => {
  const { root } = homeWith({ historyTrim: { maxInputTokens: 200_000, keepRecent: 8 } });
  const loaded = gatewayEnvFromSettings({
    XDG_CONFIG_HOME: root,
    OMNIHILBRAS_HISTORY_TRIM_TOKENS: '50000',
  });
  assert.deepEqual(loaded.env, {
    // The threshold came from the environment; keepRecent still came from the file.
    OMNIHILBRAS_HISTORY_TRIM_KEEP_RECENT: '8',
  });
});

test('a malformed file is reported and ignored, not fatal', () => {
  const { root, file } = homeWith('{ not json');
  const loaded = gatewayEnvFromSettings({ XDG_CONFIG_HOME: root });
  assert.deepEqual(loaded.env, {});
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*not valid JSON`));
});

test('a historyTrim without a threshold is refused rather than guessed at', () => {
  const { root } = homeWith({ historyTrim: { keepRecent: 8 } });
  const loaded = gatewayEnvFromSettings({ XDG_CONFIG_HOME: root });
  assert.deepEqual(loaded.env, {});
  assert.match(loaded.warnings[0], /maxInputTokens is required/);
});

test('out-of-range values are named and ignored; a valid sibling still applies', () => {
  const { root } = homeWith({ historyTrim: { maxInputTokens: 100, keepRecent: 500 } });
  const loaded = gatewayEnvFromSettings({ XDG_CONFIG_HOME: root });
  assert.deepEqual(loaded.env, {});
  assert.equal(loaded.warnings.length, 2);
  assert.ok(loaded.warnings.some((warning) => /maxInputTokens.*integer from 1000 to 10000000/.test(warning)));
  assert.ok(loaded.warnings.some((warning) => /keepRecent.*integer from 0 to 200/.test(warning)));

  const valid = homeWith({ historyTrim: { maxInputTokens: 200_000, keepRecent: 500 } });
  const partially = gatewayEnvFromSettings({ XDG_CONFIG_HOME: valid.root });
  assert.deepEqual(partially.env, { OMNIHILBRAS_HISTORY_TRIM_TOKENS: '200000' });
  assert.equal(partially.warnings.length, 1);
});

test('a historyTrim that is not an object is refused without throwing', () => {
  const { root } = homeWith({ historyTrim: '200000' });
  const loaded = gatewayEnvFromSettings({ XDG_CONFIG_HOME: root });
  assert.deepEqual(loaded.env, {});
  assert.match(loaded.warnings[0], /historyTrim must be an object/);
});

test('the real entry point applies the file before it loads the configuration', async (t) => {
  const { root } = homeWith({ historyTrim: { maxInputTokens: 50_000, keepRecent: 4 } });
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: root,
      OMNIHILBRAS_DATA_DIR: mkdtempSync(join(tmpdir(), 'omnihilbras-settings-data-')),
      OMNIHILBRAS_PORT: String(port),
      OMNIHILBRAS_OPENCODE_SERVICE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  t.after(() => child.kill('SIGKILL'));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/trims history over 50000 estimated tokens \(keep last 4\)/.test(stderr)) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(stderr, /trims history over 50000 estimated tokens \(keep last 4\)/, stderr);
  assert.doesNotMatch(stderr, /could not be read|not valid JSON/, stderr);

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
});
