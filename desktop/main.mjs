import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, shell, Tray } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { createGatewayClient } from './gateway-ipc.mjs';
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
const gateway = createGatewaySupervisor({
  projectRoot,
  cwd: app.isPackaged ? process.resourcesPath : projectRoot,
  entry: join(projectRoot, 'Kernel/API/dist/src/main.js'),
  host: '127.0.0.1',
  port: preferredPort,
  readinessTimeoutMs: 40_000,
  // 8787 is the default, not a requirement. Another local gateway must not stop this app opening.
  fallbackToFreePort: true,
  // A crash is a restart, not a dead app. Five consecutive crashes then stop trying.
  autoRestart: true,
  maxRestarts: 5,
  env: {
    OMNIHILBRAS_DATA_DIR: join(app.getPath('userData'), 'data'),
    OMNIHILBRAS_CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  },
});
const gatewayClient = createGatewayClient({ host: '127.0.0.1', port: () => gateway.port });
saveUserConfig({ gatewayPort: gateway.port });

let window;
let tray;
let quitting = false;
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

function send(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function broadcastState() {
  send('server:state', gateway.snapshot());
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
    return new Response(body, { headers: { 'content-type': mimeFor(file) } });
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
    },
  });
  window.once('ready-to-show', () => window.show());
  // Close-to-tray: the gateway keeps serving and the tray icon is the way back. Quit is the tray's
  // Quit item, which sets `quitting` first so this handler does not swallow it.
  window.on('close', (event) => {
    if (quitting) return;
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
    wireIpc();
    createWindow();
    createTray();
    try {
      await gateway.start();
    } catch {
      // The window shows the failed state and offers Restart; a startup failure is not a reason to
      // quit the app and lose the log that explains it.
    }
    broadcastState();
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
