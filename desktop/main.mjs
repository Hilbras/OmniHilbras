import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, session, shell, Tray } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { createGatewayClient } from './gateway-ipc.mjs';
import { redact } from './redact.mjs';
import { createGatewaySupervisor } from './supervisor.mjs';

/**
 * The desktop shell.
 *
 * Production has exactly one server: the gateway. The dashboard is served from `app://omnihilbras`
 * out of `dist/`, so there is no Vite process to manage and no local web server whose origin has to
 * be trusted. `app:dev` builds the same files before starting; the browser dashboard remains
 * available through `pnpm dev` for development.
 */

const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://omnihilbras`;
const DEV_URL = `${APP_ORIGIN}/dashboard/`;

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const projectRoot = app.getAppPath();
// `--user-data-dir` controls Chromium, not `app.getPath('userData')`. A smoke run must not write
// gateway usage, config or logs into the installed app's directory, so it sets this explicitly.
if (process.env.OMNIHILBRAS_USER_DATA) app.setPath('userData', process.env.OMNIHILBRAS_USER_DATA);
const distRoot = join(projectRoot, 'dist');
const configPath = join(app.getPath('userData'), 'config.json');

function readUserConfig() {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveUserConfig(patch) {
  const next = { ...readUserConfig(), ...patch };
  try {
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A read-only home still lets the app run for this session; the port is announced on screen.
  }
}

const userConfig = readUserConfig();
const preferredPort = Number(process.env.OMNIHILBRAS_PORT) || Number(userConfig.gatewayPort) || 8787;
// The CLI and the web dashboard use this directory. The desktop app used its own `userData/data`,
// which made an exported backup imported in the other surface look like it did nothing: they were
// two vaults. Share the store, and migrate a pre-existing desktop-only store once when the shared
// one is empty.
const sharedDataDir = join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'omnihilbras');
const legacyDataDir = join(app.getPath('userData'), 'data');
if (!existsSync(join(sharedDataDir, 'connections.json')) && existsSync(join(legacyDataDir, 'connections.json'))) {
  try {
    mkdirSync(sharedDataDir, { recursive: true, mode: 0o700 });
    cpSync(legacyDataDir, sharedDataDir, { recursive: true, errorOnExist: false, force: false });
  } catch {
    // A failed migration must not stop the app; the legacy directory is left untouched.
  }
}

function appSettings() {
  const config = readUserConfig();
  return {
    closeToTray: config.closeToTray !== false,
    autoStartGateway: config.autoStartGateway !== false,
    checkUpdatesOnLaunch: config.checkUpdatesOnLaunch !== false,
    gatewayPort: Number(config.gatewayPort) || preferredPort,
  };
}
const logFile = join(app.getPath('userData'), 'logs', 'gateway.log');
const gateway = createGatewaySupervisor({
  projectRoot,
  cwd: app.isPackaged ? process.resourcesPath : projectRoot,
  entry: join(projectRoot, 'Kernel/API/dist/src/main.js'),
  host: '127.0.0.1',
  port: preferredPort,
  readinessTimeoutMs: 40_000,
  logFile,
  // 8787 is the default, not a requirement. Another local gateway must not stop this app opening.
  fallbackToFreePort: true,
  // A crash is a restart, not a dead app. Five consecutive crashes then stop trying.
  autoRestart: true,
  maxRestarts: 5,
  env: {
    OMNIHILBRAS_DATA_DIR: sharedDataDir,
    OMNIHILBRAS_CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  },
});
const gatewayClient = createGatewayClient({ host: '127.0.0.1', port: () => gateway.port });
saveUserConfig({ gatewayPort: gateway.port });

let window;
let tray;
let quitting = false;
/** A downloaded update is replacing the app; `before-quit` must not defer that quit. */
let installingUpdate = false;
let logSubscription;
let logAbort;
const streamControllers = new Map();

function showWindow() {
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const state = gateway.snapshot();
  const running = state.state === 'running';
  const openAtLogin = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
  tray.setToolTip(`OmniHilbras — ${state.state} on 127.0.0.1:${state.port}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open OmniHilbras', click: showWindow },
    { type: 'separator' },
    { label: `Gateway: ${state.state} · 127.0.0.1:${state.port}`, enabled: false },
    { label: 'Start gateway', enabled: running || state.state === 'starting' ? false : true, click: () => void gateway.start().catch(() => undefined) },
    { label: 'Stop gateway', enabled: running || state.state === 'restarting', click: () => void gateway.stop() },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: openAtLogin,
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        rebuildTrayMenu();
      },
    },
    {
      label: 'Check for updates…',
      enabled: app.isPackaged,
      click: () => void checkForUpdates(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(projectRoot, 'brand/logo-32.png')));
  tray.on('click', showWindow);
  rebuildTrayMenu();
}

/**
 * Updates are a claim, not a background habit.
 *
 * Only a packaged build checks; a development run has no `app-update.yml` and would throw. A skipped
 * check is logged with its reason, never reported as "up to date" — the same rule as a provider
 * health check.
 */
let updater;
let updateState = { status: 'idle' };
function setUpdateState(next) {
  updateState = { ...updateState, ...next };
  send('update:state', updateState);
}

async function loadUpdater() {
  if (updater) return updater;
  if (!app.isPackaged) return undefined;
  const module = await import('electron-updater');
  // CJS interop differs between Electron, bundlers and Node: the updater can be a named export or
  // hang off `default`. Destructuring the named binding produced `undefined` and then the first
  // assignment (`autoUpdater.autoDownload = false`) threw.
  const autoUpdater = module.autoUpdater ?? module.default?.autoUpdater;
  if (!autoUpdater) throw new Error('electron-updater did not expose autoUpdater.');
  autoUpdater.autoDownload = false;
  // The update is installed only from the explicit "Install and restart" action, not as a side effect
  // of the user quitting for another reason.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    // A .deb cannot replace itself through electron-updater; Windows NSIS and signed macOS can.
    const canInstall = process.platform !== 'linux';
    setUpdateState({ status: 'available', version: info.version, canInstall });
    if (Notification.isSupported()) {
      new Notification({
        title: 'OmniHilbras update available',
        body: canInstall
          ? `${info.version} is available. Open About to download it.`
          : `${info.version} is available. Open the release page to install it.`,
      }).show();
    }
    gateway.pushLog('stdout', `Update available: ${info.version}.\n`);
  });
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'current' }));
  autoUpdater.on('download-progress', (progress) => setUpdateState({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ status: 'downloaded', version: info.version, canInstall: process.platform !== 'linux' }));
  autoUpdater.on('error', (error) => {
    const reason = error instanceof Error ? error.message : String(error);
    gateway.pushLog('stderr', `Update error: ${reason}\n`);
    setUpdateState({ status: 'error', reason });
  });
  updater = autoUpdater;
  return updater;
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    setUpdateState({ status: 'skipped', reason: 'development build' });
    gateway.pushLog('stderr', 'Update check skipped: development build.\n');
    return updateState;
  }
  try {
    const active = await loadUpdater();
    setUpdateState({ status: 'checking' });
    await active.checkForUpdates();
    return updateState;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gateway.pushLog('stderr', `Update check unavailable: ${reason}\n`);
    setUpdateState({ status: 'error', reason });
    if (manual) throw new Error(reason);
    return updateState;
  }
}

async function downloadUpdate() {
  const active = await loadUpdater();
  if (!active) throw new Error('Updates are only available in an installed build.');
  setUpdateState({ status: 'downloading', percent: 0 });
  await active.downloadUpdate();
  return updateState;
}

async function installUpdate() {
  if (!updater || updateState.status !== 'downloaded') throw new Error('No downloaded update is ready to install.');
  setUpdateState({ status: 'installing' });
  // Stop the gateway before the installer takes over the app directory. The ordinary quit path does
  // this from `before-quit`, but quitting for an update must not be deferred by that handler or the
  // installer can race a process that still holds the files it replaces.
  installingUpdate = true;
  quitting = true;
  try {
    await stopLogForwarding();
    await gateway.stop();
  } catch {
    // The installer is still the right next step; a supervisor that already stopped is fine.
  }
  updater.quitAndInstall(false, true);
}

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function broadcastState() {
  send('server:state', gateway.snapshot());
}

async function exportDiagnostics() {
  const directory = join(app.getPath('userData'), 'diagnostics');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let logText = '';
  try {
    logText = readFileSync(logFile, 'utf8');
  } catch {
    // A first run has no log file yet.
  }
  const snapshot = gateway.snapshot();
  const file = join(directory, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    },
    paths: {
      userData: app.getPath('userData'),
      data: join(app.getPath('userData'), 'data'),
      logs: dirname(logFile),
    },
    config: readUserConfig(),
    server: { ...snapshot, logs: snapshot.logs.slice(-50) },
    logTail: redact(logText).slice(-200_000),
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  shell.showItemInFolder(file);
  return { path: file };
}

gateway.on('state', broadcastState);
gateway.on('state', (state) => {
  if (state.state === 'running') saveUserConfig({ gatewayPort: state.port });
  rebuildTrayMenu();
});
gateway.on('log', (entry) => send('server:log', entry));

async function startLogForwarding() {
  await stopLogForwarding();
  logAbort = new AbortController();
  try {
    logSubscription = await gatewayClient.subscribeLogs((event) => send('gateway:log', event), { signal: logAbort.signal });
    send('gateway:log-state', { connected: true });
  } catch (error) {
    send('gateway:log-state', { connected: false, reason: error instanceof Error ? error.message : 'The log stream is unavailable.' });
  }
}

async function stopLogForwarding() {
  logAbort?.abort();
  logAbort = undefined;
  const close = logSubscription;
  logSubscription = undefined;
  await close?.();
}

gateway.on('state', (state) => {
  if (state.state === 'running') void startLogForwarding();
  else if (state.state !== 'starting') void stopLogForwarding();
});

function mimeFor(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function isInside(root, candidate) {
  const normalized = normalize(candidate);
  return normalized === root || normalized.startsWith(`${root}${sep}`);
}

const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' app:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

async function serveApp(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname.startsWith('/dashboard')) {
    // Every dashboard route is the same SPA entry; BrowserRouter owns the path.
    pathname = '/dashboard.html';
  }
  const file = join(distRoot, pathname);
  if (!isInside(distRoot, file)) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        'content-type': mimeFor(file),
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function wireIpc() {
  ipcMain.handle('server:state', () => gateway.snapshot());
  ipcMain.handle('server:start', async () => {
    try {
      return await gateway.start();
    } finally {
      broadcastState();
    }
  });
  ipcMain.handle('server:stop', async () => {
    try {
      return await gateway.stop();
    } finally {
      broadcastState();
    }
  });
  ipcMain.handle('server:restart', async () => {
    try {
      return await gateway.restart();
    } finally {
      broadcastState();
    }
  });

  ipcMain.on('window:minimize', () => window?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on('window:close', () => window?.close());
  ipcMain.handle('window:is-maximized', () => window?.isMaximized() ?? false);
  ipcMain.handle('diagnostics:export', exportDiagnostics);
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));
  ipcMain.handle('backup:save', async (_event, payload) => {
    if (!payload || typeof payload.content !== 'string' || typeof payload.filename !== 'string') throw new Error('The backup could not be written.');
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Save encrypted backup',
      defaultPath: join(app.getPath('downloads'), payload.filename),
      filters: [{ name: 'OmniHilbras backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { saved: false };
    writeFileSync(filePath, payload.content, { mode: 0o600 });
    return { saved: true, path: filePath };
  });
  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:install', () => installUpdate());
  ipcMain.handle('update:open-release', () => {
    void shell.openExternal('https://github.com/Hilbras/OmniHilbras/releases/latest');
  });
  /**
   * Opens a provider sign-in page in the user's browser.
   *
   * `window.open('about:blank')` is denied by the window-open handler on purpose: a second Electron
   * window would carry a preload and this app's privileges. The renderer therefore cannot navigate a
   * tab it opened, and the old flow waited for the user to click an "Open" link. This bridge lets the
   * sign-in start from the click that chose the provider, with no second click.
   */
  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url !== 'string') throw new Error('A URL string is required.');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('That sign-in URL is not valid.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only http and https links can be opened.');
    }
    await shell.openExternal(parsed.toString());
  });
  ipcMain.handle('settings:get', () => appSettings());
  ipcMain.handle('settings:set', async (_event, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Settings must be an object.');
    const next = {};
    for (const key of ['closeToTray', 'autoStartGateway', 'checkUpdatesOnLaunch']) {
      if (key in patch) {
        if (typeof patch[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
        next[key] = patch[key];
      }
    }
    if ('gatewayPort' in patch) {
      const port = Number(patch.gatewayPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The gateway port must be between 1024 and 65535.');
      next.gatewayPort = port;
    }
    const portChanged = next.gatewayPort !== undefined && next.gatewayPort !== gateway.port;
    saveUserConfig(next);
    if (next.gatewayPort !== undefined) gateway.setPort(next.gatewayPort);
    if (portChanged && gateway.state === 'running') await gateway.restart();
    rebuildTrayMenu();
    return appSettings();
  });

  ipcMain.handle('gateway:request', async (_event, request) => {
    try {
      return await gatewayClient.request(request ?? {});
    } catch (error) {
      return { ok: false, status: 0, text: error instanceof Error ? error.message : 'The gateway request failed.' };
    }
  });

  ipcMain.on('gateway:stream:start', async (event, id, request) => {
    const controller = new AbortController();
    streamControllers.set(id, controller);
    const chunkChannel = `gateway:stream:chunk:${id}`;
    const endChannel = `gateway:stream:end:${id}`;
    const errorChannel = `gateway:stream:error:${id}`;
    try {
      const upstream = await gatewayClient.streamChat({ ...request, signal: controller.signal });
      if (!upstream.ok || !upstream.stream) {
        event.sender.send(errorChannel, upstream.text || `The gateway answered ${upstream.status}.`);
        return;
      }
      const reader = upstream.stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        event.sender.send(chunkChannel, decoder.decode(value, { stream: true }));
      }
      event.sender.send(endChannel);
    } catch (error) {
      if (!controller.signal.aborted) {
        event.sender.send(errorChannel, error instanceof Error ? error.message : 'The stream failed.');
      }
    } finally {
      streamControllers.delete(id);
    }
  });
  ipcMain.on('gateway:stream:cancel', (_event, id) => {
    streamControllers.get(id)?.abort();
    streamControllers.delete(id);
  });
}

const isMac = process.platform === 'darwin';

function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0c0b09',
    title: 'OmniHilbras',
    icon: join(projectRoot, 'brand/logo-512.png'),
    show: false,
    // The dashboard header is the title bar. macOS keeps its traffic lights (hiddenInset); Linux and
    // Windows get a frameless window with the controls rendered in the header, because a native title
    // bar above the app's own navigation was two bars saying the same thing.
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    webPreferences: {
      preload: join(projectRoot, 'desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      ...(process.env.OMNIHILBRAS_SMOKE === '1' ? { additionalArguments: ['--omnihilbras-smoke'] } : {}),
    },
  });
  window.once('ready-to-show', () => window.show());
  // Close-to-tray: the gateway keeps serving and the tray icon is the way back. Quit is the tray's
  // Quit item, which sets `quitting` first so this handler does not swallow it.
  window.on('close', (event) => {
    if (quitting) return;
    if (!appSettings().closeToTray) {
      quitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    window.hide();
  });
  const sendMaximized = () => send('window:maximized', window?.isMaximized() ?? false);
  window.on('maximize', sendMaximized);
  window.on('unmaximize', sendMaximized);
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Provider links belong in the user's browser, never in a second Electron window with a preload.
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN)) return;
    event.preventDefault();
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
  });
  window.loadURL(DEV_URL).catch((error) => {
    window.loadURL(`data:text/html,<pre>OmniHilbras failed to load: ${String(error.message)}</pre>`);
  });

  if (process.env.OMNIHILBRAS_SMOKE === '1') {
    window.webContents.once('did-finish-load', async () => {
      try {
        // One poll of the status hook and one supervisor state read; a capture at `did-finish-load`
        // sees the shell before either resolves.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        for (let attempt = 0; attempt < 40 && gateway.state === 'starting'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const title = await window.webContents.executeJavaScript('document.title');
        const probe = await window.webContents.executeJavaScript("window.omnihilbras.gateway.request('/v1/connections').then(r => ({ status: r.status, ok: r.ok }))");
        const text = await window.webContents.executeJavaScript('document.body.innerText.slice(0, 500)');
        const cycle = await window.webContents.executeJavaScript(`(async () => {
          const stopped = await window.omnihilbras.server.stop();
          const started = await window.omnihilbras.server.start();
          return { stopped: stopped.state, started: started.state };
        })()`);
        const feed = await window.webContents.executeJavaScript(`(async () => {
          await window.omnihilbras.gateway.request('/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ model: 'definitely-not-a-model', messages: [{ role: 'user', content: 'hi' }] }),
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          return document.querySelector('[aria-label="Live requests"]')?.innerText ?? '';
        })()`);
        const controls = await window.webContents.executeJavaScript(`(async () => {          const minimize = Boolean(document.querySelector('[aria-label="Minimize window"]'));
          const maximize = Boolean(document.querySelector('[aria-label="Maximize window"], [aria-label="Restore window"]'));
          const draggable = Boolean(document.querySelector('header.window-drag'));
          const before = await window.omnihilbras.windowControls.isMaximized();
          window.omnihilbras.windowControls.toggleMaximize();
          await new Promise((resolve) => setTimeout(resolve, 400));
          const after = await window.omnihilbras.windowControls.isMaximized();
          if (after) {
            window.omnihilbras.windowControls.toggleMaximize();
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return { minimize, maximize, draggable, before, after };
        })()`);
        const shells = await window.webContents.executeJavaScript(`({ shells: document.querySelectorAll('.dashboard-shell').length, serversHeadings: [...document.querySelectorAll('h1,h2')].filter((node) => node.textContent === 'Servers').length })`);
        console.log(`SMOKE ${JSON.stringify({ url: window.webContents.getURL(), title, probe, cycle, controls, shells, feed, text, server: gateway.snapshot() })}`);
      } catch (error) {
        console.log(`SMOKE-ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
      await gateway.stop();
      app.quit();
    });
  }
}

const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    protocol.handle(APP_SCHEME, serveApp);
    // The dashboard needs no browser permission: no camera, microphone, notifications, clipboard read,
    // geolocation or MIDI. Refusing all of them is smaller than an allowlist and cannot drift.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    wireIpc();
    createWindow();
    createTray();
    if (appSettings().autoStartGateway) {
      try {
        await gateway.start();
      } catch {
        // The window shows the failed state and offers Restart; a startup failure is not a reason to
        // quit the app and lose the log that explains it.
      }
    }
    broadcastState();
    if (appSettings().checkUpdatesOnLaunch) setTimeout(() => { void checkForUpdates(); }, 5_000);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // The app lives in the tray. Closing the last window hides it; only the tray's Quit exits.
  // This handler exists to stop Electron's default "quit when the last window closes".
  app.on('window-all-closed', () => undefined);
  let quittingSeen = false;
  app.on('before-quit', (event) => {
    // `before-quit` is synchronous, so an un-awaited stop is a race: Electron can exit before the
    // gateway sees SIGTERM, leaving the port held. The first quit is deferred until the child is gone.
    if (quittingSeen) return;
    if (installingUpdate) {
      quittingSeen = true;
      return;
    }
    event.preventDefault();
    quittingSeen = true;
    quitting = true;
    void (async () => {
      await stopLogForwarding();
      await gateway.stop();
      app.quit();
    })();
  });
}
