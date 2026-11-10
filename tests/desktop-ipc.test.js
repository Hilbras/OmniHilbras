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

test('the app keeps running in the tray and owns its lifecycle', () => {
  const main = read('./desktop/main.mjs');
  const supervisor = read('./desktop/supervisor.mjs');
  assert.match(main, /fallbackToFreePort: true/, 'a busy default port stops the app from opening');
  assert.match(main, /autoRestart: true/, 'a gateway crash leaves the app dead');
  assert.match(main, /new Tray\(/, 'there is no tray icon');
  assert.match(main, /setLoginItemSettings/, 'start at login is not wired');
  assert.match(main, /event\.preventDefault\(\);\s*\n\s*window\.hide\(\)/, 'closing the window quits instead of hiding to tray');
  assert.match(supervisor, /taskkill/, 'Windows does not kill the process tree');
});

test('the app smoke script drives the real binary', () => {
  const script = read('./scripts/app-smoke.mjs');
  assert.match(script, /OMNIHILBRAS_SMOKE: '1'/, 'the smoke run does not enable smoke mode');
  assert.match(script, /OMNIHILBRAS_USER_DATA: userData/, 'the smoke run shares the installed app data directory');
  assert.match(script, /nested dashboard shell/, 'the smoke does not check for the duplicated shell');
});

test('the packaged renderer is locked down', () => {
  const main = read('./desktop/main.mjs');
  assert.match(main, /content-security-policy/, 'no CSP on app:// responses');
  assert.match(main, /setPermissionRequestHandler\([\s\S]*?callback\(false\)/, 'permission requests are not denied');
  assert.match(main, /will-navigate/, 'navigation away from app:// is not blocked');
  assert.match(main, /devTools: !app\.isPackaged/, 'DevTools stay enabled in packaged builds');
  assert.match(read('./dashboard.html'), /src="\/theme-boot\.js"/, 'the inline theme script is back, which the CSP blocks');
  assert.doesNotMatch(read('./dashboard.html'), /<script>/, 'an inline script would be blocked by the CSP');
});

test('development start degrades the sandbox only when the helper is broken', () => {
  const runner = read('./scripts/run-electron.mjs');
  assert.match(runner, /chrome-sandbox/, 'the runner never checks the sandbox helper');
  assert.match(runner, /args\.push\('--no-sandbox'\)/, 'there is no fallback for a broken helper');
  assert.match(runner, /sandboxIsConfigured\(\)/, 'the fallback is unconditional');
});

test('updates are checked only by a packaged build, and a skip is never "current"', () => {
  const main = read('./desktop/main.mjs');
  const pkg = JSON.parse(read('./package.json'));
  assert.match(main, /async function checkForUpdates/, 'there is no update check');
  assert.match(main, /if \(!app\.isPackaged\)/, 'a development build attempts an update check');
  assert.match(main, /status: 'error'/, 'a failed check is not reported honestly');
  assert.match(main, /Update check skipped/, 'a skipped check is not logged');
  assert.equal(pkg.build.publish?.[0]?.provider, 'github', 'there is no update feed');
});

test('packaging targets and the desktop CI matrix cover the three platforms', () => {
  const pkg = JSON.parse(read('./package.json'));
  assert.ok(pkg.build.linux.target.includes('deb'));
  assert.ok(pkg.build.win.target.includes('nsis'));
  assert.ok(pkg.build.mac.target.includes('dmg'));
  const workflow = read('./.github/workflows/desktop.yml');
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    assert.match(workflow, new RegExp(os), `desktop CI does not build ${os}`);
  }
  assert.match(workflow, /app:smoke/, 'desktop CI does not smoke the app');
});

test('desktop settings are persisted and actually applied', () => {
  const main = read('./desktop/main.mjs');
  const supervisor = read('./desktop/supervisor.mjs');
  assert.match(main, /settings:set/, 'no settings write path');
  assert.match(main, /appSettings\(\)\.closeToTray/, 'close-to-tray is not read when the window closes');
  assert.match(main, /appSettings\(\)\.autoStartGateway/, 'start-on-launch is not read');
  assert.match(main, /appSettings\(\)\.checkUpdatesOnLaunch/, 'update-check-on-launch is not read');
  assert.match(main, /gateway\.setPort/, 'the gateway port cannot change');
  assert.match(supervisor, /setPort\(port\)/, 'the supervisor has no port setter');
  assert.match(main, /await gateway\.restart\(\)/, 'a port change does not restart the gateway');
});

test('the updater resolves both CJS interop shapes', () => {
  const main = read('./desktop/main.mjs');
  assert.match(main, /module\.autoUpdater \?\? module\.default\?\.autoUpdater/, 'autoUpdater is destructured from one shape only');
  assert.match(main, /electron-updater did not expose autoUpdater/, 'a missing updater is not reported');
});

test('installing an update stops the gateway and is not deferred by the quit guard', () => {
  const main = read('./desktop/main.mjs');
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = false/, 'an update can install as a side effect of a normal quit');
  assert.match(main, /installingUpdate = true/, 'the update quit is not distinguished from a normal quit');
  assert.match(main, /await gateway\.stop\(\)/, 'the installer can race a gateway that still holds files');
  assert.match(main, /if \(installingUpdate\) \{/, 'the ordinary quit guard still defers the update quit');
});

test('desktop and web share one vault directory', () => {
  const main = read('./desktop/main.mjs');
  assert.match(main, /OMNIHILBRAS_DATA_DIR: sharedDataDir/, 'the desktop app still uses its own data directory');
  assert.match(main, /\.config.*omnihilbras|`omnihilbras`/, 'the shared directory is not the CLI default');
  assert.match(main, /legacyDataDir/, 'there is no migration from the old desktop-only store');
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
