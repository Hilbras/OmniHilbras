/**
 * The native bridge, when the dashboard is running inside the desktop app.
 *
 * A browser has no `window.omnihilbras`; every caller feature-detects and keeps its existing
 * implementation for `pnpm dev`. The bridge is deliberately narrow: no filesystem, no shell, no token.
 */

export type DesktopServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export type DesktopServerLog = {
  at: string;
  stream: 'stdout' | 'stderr';
  line: string;
};

export type DesktopServerSnapshot = {
  state: DesktopServerState;
  host: string;
  port: number;
  pid?: number;
  startedAt?: string;
  lastError?: string;
  logs: DesktopServerLog[];
};

export type DesktopLogEvent = {
  at?: string;
  model?: string;
  providerId?: string;
  connectionId?: string;
  outcome?: 'success' | 'failure' | 'cancelled';
  errorCode?: string;
  attempts?: number;
  latencyMs?: number;
  requestId?: string;
  streamError?: string;
};

type GatewayResponse = { ok: boolean; status: number; text: string };

type StreamHandlers = {
  onChunk: (text: string) => void;
  onEnd: () => void;
  onError: (error: Error) => void;
};

export type OmniBridge = {
  desktop: true;
  /** `process.platform`, so the header can keep macOS traffic lights and draw its own controls elsewhere. */
  platform: string;
  windowControls: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximized: (callback: (maximized: boolean) => void) => () => void;
  };
  server: {
    getState: () => Promise<DesktopServerSnapshot>;
    start: () => Promise<DesktopServerSnapshot>;
    stop: () => Promise<DesktopServerSnapshot>;
    restart: () => Promise<DesktopServerSnapshot>;
    onState: (callback: (state: DesktopServerSnapshot) => void) => () => void;
    onLog: (callback: (entry: DesktopServerLog) => void) => () => void;
  };
  gateway: {
    request: (path: string, init?: { method?: string; body?: string }) => Promise<GatewayResponse>;
    streamChat: (path: string, init: { body: string }, handlers: StreamHandlers) => () => void;
    onLog: (callback: (event: DesktopLogEvent) => void) => () => void;
    onLogState: (callback: (state: { connected: boolean; reason?: string }) => void) => () => void;
  };
};

declare global {
  interface Window {
    omnihilbras?: OmniBridge;
  }
}

export function desktopBridge(): OmniBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.omnihilbras?.desktop ? window.omnihilbras : undefined;
}
