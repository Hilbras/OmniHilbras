import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertGatewayPath,
  bindStreamAbortToOwnership,
  createGatewayClient,
  createStreamControllerRegistry,
  dashboardTokenPath,
  isTrustedIpcSender,
  readDashboardTokenFile,
  sendToTrustedIpc,
} from '../desktop/gateway-ipc.mjs';
import { createGatewaySupervisor } from '../desktop/supervisor.mjs';

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

test('a .deb update is checked and handed to the system installer', () => {
  const main = read('./desktop/main.mjs');
  assert.match(main, /endsWith\('\.deb'\)/, 'the update feed is not checked for a .deb');
  assert.match(main, /createHash\('sha512'\)/, 'a downloaded .deb is installed without verifying its checksum');
  assert.match(main, /shell\.openPath\(pendingDebPath\)/, 'the .deb is not handed to the system package installer');
  assert.match(main, /installMethod: debUpdate \? 'deb' : 'auto'/, 'the UI cannot distinguish the .deb path');
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

test('the desktop app serves its own pair: gateway 20198, web 20197', () => {
  // The development pair is 20137/20138 and the original desktop pair was 20127/20128. The packaged app must
  // not compete with either. Both ports are overridable at runtime so a built app can be moved without a rebuild.
  const main = read('./desktop/main.mjs');
  assert.match(main, /const DESKTOP_GATEWAY_PORT = 20198;/, 'the desktop gateway port is not 20198');
  assert.match(main, /const DESKTOP_WEB_PORT = 20197;/, 'the desktop web port is not 20197');
  assert.match(main, /legacyPorts = new Set\(\[8787, 20137, 20138, 20128\]\)/, 'an upgraded install would keep an old port');
  assert.match(main, /legacyWebPorts = new Set\(\[20127\]\)/, 'the old web origin would stay trusted');
  assert.match(main, /OMNIHILBRAS_WEB_PORT/, 'the web port cannot be overridden without rebuilding');
  assert.match(main, /port: preferredPort/, 'the supervisor is not given the resolved port');
  assert.match(main, /OMNIHILBRAS_CORS_ORIGINS: \['http:\/\/localhost:5173', 'http:\/\/127\.0\.0\.1:5173', \.\.\.corsOrigins\(\)\]/, 'the trusted origins are not built from the active pair');
  assert.match(main, /saveUserConfig\(\{ gatewayPort: gateway\.port, webPort: resolvedWebPort \}\)/, 'the resolved pair is not persisted');
});

/**
 * Phase 1 desktop hardening: ownership precedes credentials, and only the app frame may drive IPC.
 *
 * These use a real HTTP server rather than a mocked `fetch`, because the claim is "no request reached the
 * gateway" — a mock proves only that our code called the mock. The token reader is injected where the
 * claim is "the file was never read", which is the other half of the same rule.
 */

const FIXTURE = join(ROOT, 'tests/support/fake-gateway.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function recordingGateway(t) {
  const hits = [];
  const server = createHttpServer((request, response) => {
    hits.push({ url: request.url, token: request.headers['x-omnihilbras-dashboard-token'] });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { hits, port: server.address().port };
}

for (const label of ['stopped', 'starting', 'failed', 'restarting']) {
  test(`no token is read and no request is sent while the gateway is ${label}`, async (t) => {
    const { hits, port } = await recordingGateway(t);
    let reads = 0;
    const client = createGatewayClient({
      port: () => port,
      isOwned: () => false,
      readToken: async () => {
        reads += 1;
        return 'secret-token';
      },
    });
    await assert.rejects(() => client.request({ path: '/v1/connections' }), /not running/i);
    await assert.rejects(() => client.streamChat({ body: '{}' }), /not running/i);
    await assert.rejects(() => client.subscribeLogs(() => undefined), /not running/i);
    assert.equal(reads, 0, 'the token was read for a gateway this app does not own');
    assert.equal(hits.length, 0, 'a request reached the gateway');
  });
}

test('an owned gateway reads the token and sends it', async (t) => {
  const { hits, port } = await recordingGateway(t);
  const client = createGatewayClient({ port: () => port, isOwned: () => true, readToken: async () => 'secret-token' });
  const result = await client.request({ path: '/v1/connections' });
  assert.equal(result.ok, true);
  assert.equal(hits.length, 1, 'the request never reached the gateway');
  assert.equal(hits[0].token, 'secret-token', 'the token was not presented');
});

test('ownership is checked again after the token read, before the fetch', async (t) => {
  const { hits, port } = await recordingGateway(t);
  let owned = true;
  let reads = 0;
  const client = createGatewayClient({
    port: () => port,
    isOwned: () => owned,
    // The read is the last thing before the second check: losing ownership mid-call must stop the fetch.
    readToken: async () => {
      reads += 1;
      owned = false;
      return 'secret-token';
    },
  });
  await assert.rejects(() => client.request({ path: '/v1/connections' }), /not running/i);
  assert.equal(reads, 1, 'the token was read');
  assert.equal(hits.length, 0, 'the request was sent after ownership was lost mid-call');
});

test('only the app frame is a trusted IPC sender', () => {
  const appContents = { id: 1, getURL: () => 'app://omnihilbras/dashboard/' };
  assert.equal(isTrustedIpcSender({ sender: appContents }, appContents), true, 'the window is not trusted');
  assert.equal(
    isTrustedIpcSender({ sender: { id: 2, getURL: () => 'app://omnihilbras/dashboard/' } }, appContents),
    false,
    'a second webContents inherited the window\'s trust',
  );
  assert.equal(
    isTrustedIpcSender({ sender: appContents }, { id: 1, getURL: () => 'https://evil.example/' }),
    true,
    'identity alone did not trust the window',
  );
  assert.equal(
    isTrustedIpcSender({ sender: { id: 3, getURL: () => 'https://evil.example/' } }, appContents),
    false,
    'a foreign document was trusted',
  );
  assert.equal(
    isTrustedIpcSender({ sender: { id: 4, getURL: () => 'app://omnihilbras.evil.example/' } }, appContents),
    false,
    'a prefix lookalike was treated as the app origin',
  );
  assert.equal(isTrustedIpcSender({ sender: { id: 5 } }, appContents), false, 'a sender with no URL and no identity was trusted');
  assert.equal(isTrustedIpcSender({}, appContents), false, 'an event with no sender was trusted');
  assert.equal(isTrustedIpcSender({ sender: appContents }), false, 'a sender was trusted without a reference window');
});

test('a foreign listener receives nothing', () => {
  const appContents = { id: 1, getURL: () => 'app://omnihilbras/' };
  const delivered = [];
  const foreign = { id: 9, getURL: () => 'https://evil.example/', send: (channel, payload) => delivered.push({ channel, payload }) };
  const trusted = { id: 1, getURL: () => 'app://omnihilbras/', send: (channel, payload) => delivered.push({ channel, payload }) };

  assert.equal(sendToTrustedIpc({ sender: foreign }, appContents, 'gateway:stream:chunk:1', 'secret'), false);
  assert.equal(delivered.length, 0, 'a foreign sender received a chunk');
  assert.equal(sendToTrustedIpc({ sender: trusted }, appContents, 'gateway:stream:chunk:1', 'secret'), true);
  assert.deepEqual(delivered, [{ channel: 'gateway:stream:chunk:1', payload: 'secret' }]);
});

test('losing ownership aborts every tracked credential stream', () => {
  const supervisor = new EventEmitter();
  supervisor.owned = true;
  supervisor.ownsRunningChild = () => supervisor.owned;
  const registry = createStreamControllerRegistry();
  const unbind = bindStreamAbortToOwnership(supervisor, registry);
  try {
    const controller = new AbortController();
    registry.set('chat-1', controller);
    assert.equal(controller.signal.aborted, false);

    supervisor.owned = false;
    supervisor.emit('state', { state: 'restarting' });
    assert.equal(controller.signal.aborted, true, 'the stream survived ownership loss');
    assert.equal(registry.size, 0, 'the registry still holds an aborted stream');
  } finally {
    unbind();
  }
});

test('a gateway child that exits aborts its streams', async (t) => {
  const port = await freePort();
  const supervisor = createGatewaySupervisor({
    projectRoot: ROOT,
    entry: FIXTURE,
    host: '127.0.0.1',
    port,
    readinessTimeoutMs: 8_000,
    readinessPollMs: 50,
    autoRestart: true,
    maxRestarts: 2,
    restartBackoffMs: [2_000],
    env: { FAKE_CRASH_AFTER_MS: '300' },
  });
  const registry = createStreamControllerRegistry();
  const unbind = bindStreamAbortToOwnership(supervisor, registry);
  t.after(async () => {
    unbind();
    await supervisor.stop();
  });

  await supervisor.start();
  const controller = new AbortController();
  registry.set('chat-1', controller);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !controller.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(controller.signal.aborted, true, 'the stream survived its gateway child');
});

async function tokenSandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-token-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the token reader accepts an owner-only regular file', async (t) => {
  const directory = await tokenSandbox(t);
  const path = join(directory, 'dashboard-token');
  await writeFile(path, 'abc123\n', { mode: 0o600 });
  assert.equal(await readDashboardTokenFile(path), 'abc123');
});

test('the token reader refuses symlinks without following them', async (t) => {
  const directory = await tokenSandbox(t);
  const target = join(directory, 'real-token');
  const link = join(directory, 'dashboard-token');
  await writeFile(target, 'stolen\n', { mode: 0o600 });
  await symlink(target, link);
  assert.equal(await readDashboardTokenFile(link), undefined);
});

test('the token reader refuses non-regular files', async (t) => {
  const directory = await tokenSandbox(t);
  const path = join(directory, 'dashboard-token');
  await mkdir(path, { mode: 0o700 });
  assert.equal(await readDashboardTokenFile(path), undefined);
});

test('the token reader enforces its byte bound', async (t) => {
  const directory = await tokenSandbox(t);
  const path = join(directory, 'dashboard-token');
  await writeFile(path, 'a'.repeat(257), { mode: 0o600 });
  assert.equal(await readDashboardTokenFile(path), undefined, 'an oversized token was read');
  await writeFile(path, 'a'.repeat(256), { mode: 0o600 });
  assert.equal((await readDashboardTokenFile(path)).length, 256);
});

test('the token reader refuses a file other users can read', async (t) => {
  if (process.platform === 'win32') return;
  const directory = await tokenSandbox(t);
  const path = join(directory, 'dashboard-token');
  await writeFile(path, 'abc123\n', { mode: 0o600 });
  await chmod(path, 0o644);
  assert.equal(await readDashboardTokenFile(path), undefined, 'a world-readable token was accepted');
});

test('a missing token is not an error', async (t) => {
  const directory = await tokenSandbox(t);
  assert.equal(await readDashboardTokenFile(join(directory, 'dashboard-token')), undefined);
});

test('the token path honours XDG_CONFIG_HOME', () => {
  assert.equal(dashboardTokenPath({ XDG_CONFIG_HOME: '/tmp/example-config' }), join('/tmp/example-config', 'omnihilbras', 'dashboard-token'));
});
