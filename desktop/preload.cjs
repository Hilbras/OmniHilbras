const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer's whole native surface.
 *
 * CommonJS on purpose: a sandboxed preload cannot load an ES module, and `sandbox: true` is worth more
 * than module symmetry. No `ipcRenderer`, no Node, no token. Each function names one operation; the
 * main process still validates methods and paths.
 */

let nextStreamId = 0;

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('omnihilbras', {
  desktop: true,
  platform: process.platform,
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximized: (callback) => subscribe('window:maximized', callback),
  },
  server: {
    getState: () => ipcRenderer.invoke('server:state'),
    start: () => ipcRenderer.invoke('server:start'),
    stop: () => ipcRenderer.invoke('server:stop'),
    restart: () => ipcRenderer.invoke('server:restart'),
    onState: (callback) => subscribe('server:state', callback),
    onLog: (callback) => subscribe('server:log', callback),
  },
  gateway: {
    request: (path, init = {}) => ipcRenderer.invoke('gateway:request', {
      path,
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    /**
     * A streaming POST. Chunks are decoded text, not parsed frames: the renderer already owns the SSE
     * parser, and duplicating it here would let the two drift.
     */
    streamChat: (path, init, handlers) => {
      const id = ++nextStreamId;
      const chunkChannel = `gateway:stream:chunk:${id}`;
      const endChannel = `gateway:stream:end:${id}`;
      const errorChannel = `gateway:stream:error:${id}`;
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        ipcRenderer.removeListener(chunkChannel, chunk);
        ipcRenderer.removeListener(endChannel, end);
        ipcRenderer.removeListener(errorChannel, fail);
      };
      const chunk = (_event, text) => handlers.onChunk(text);
      const end = () => {
        cleanup();
        handlers.onEnd();
      };
      const fail = (_event, message) => {
        cleanup();
        handlers.onError(new Error(message));
      };
      ipcRenderer.on(chunkChannel, chunk);
      ipcRenderer.on(endChannel, end);
      ipcRenderer.on(errorChannel, fail);
      ipcRenderer.send('gateway:stream:start', id, { path, body: init.body });
      return () => {
        cleanup();
        ipcRenderer.send('gateway:stream:cancel', id);
      };
    },
    onLog: (callback) => subscribe('gateway:log', callback),
    onLogState: (callback) => subscribe('gateway:log-state', callback),
  },
});
