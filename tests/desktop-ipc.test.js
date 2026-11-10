import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGatewayPath } from '../desktop/gateway-ipc.mjs';

/**
 * The IPC boundary. A renderer controls the path and method it asks for, so these are the checks that
 * stop it becoming a general HTTP client for the machine.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('gateway paths must be local and on the served surface', () => {
  assert.equal(assertGatewayPath('/v1/connections'), '/v1/connections');
  assert.equal(assertGatewayPath('/v1/usage?period=7d'), '/v1/usage?period=7d');
  assert.equal(assertGatewayPath('/health'), '/health');
  for (const bad of ['https://example.com/v1/connections', '//example.com/v1/connections', '/v1/../secrets', '/etc/passwd', '/v1/%2e%2e/secrets', 'v1/connections']) {
    assert.throws(() => assertGatewayPath(bad), /Gateway/);
  }
});

test('the preload is CommonJS, because a sandboxed preload cannot be an ES module', () => {
  const preload = read('./desktop/preload.cjs');
  assert.match(preload, /require\('electron'\)/, 'the preload does not use require');
  assert.doesNotMatch(preload, /^\s*import\s/m, 'the preload is an ES module and will not load under sandbox: true');
});

test('the renderer never names the dashboard token or reads vault files', () => {
  const source = read('./src/lib/gatewayClient.ts');
  assert.doesNotMatch(source, /dashboard-token|dashboardToken|secrets\.enc|secrets\.key/i, 'a renderer module references credential material');
  assert.match(source, /desktopBridge/, 'the client has no desktop transport');
});

test('the desktop shell enables context isolation and no Node integration', () => {
  const main = read('./desktop/main.mjs');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
});

test('the shell does not leave the gateway running after quit hooks', () => {
  const main = read('./desktop/main.mjs');
  assert.match(main, /before-quit[\s\S]*gateway\.stop\(\)/, 'nothing stops the gateway on quit');
});

test('the app header is the title bar, with its own controls', () => {
  const main = read('./desktop/main.mjs');
  const preload = read('./desktop/preload.cjs');
  const controls = read('./src/components/WindowControls.tsx');
  assert.match(main, /titleBarStyle: 'hiddenInset'/, 'macOS lost its traffic lights');
  assert.match(main, /frame: false/, 'Linux/Windows still draw a native title bar above the navigation');
  assert.match(preload, /windowControls/, 'the header has no way to minimize, maximize, or close');
  assert.match(controls, /window-no-drag/, 'a control sits inside the drag region and cannot be clicked');
  assert.match(controls, /bridge\.platform === 'darwin'/, 'macOS would get a second set of window controls');
  assert.match(read('./src/components/DashboardShell.tsx'), /window-drag/, 'the header is not draggable');
});
