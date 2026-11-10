import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';

/**
 * Owns the gateway child process for the desktop app.
 *
 * The launcher (`bin/omnihilbras.js`) already proved the rules this needs: readiness is a real
 * connection rather than a sleep, the listener is a child of the process we spawn, and stopping must
 * reach the process group. This is the same behaviour as a library, scoped to one server, with the
 * state and log ring the app renders.
 *
 * It deliberately does not import Electron. The app passes its own `execPath` and environment, so the
 * supervisor is testable with a plain Node fixture and the packaged app can use Electron's Node.
 */

export const STATES = ['stopped', 'starting', 'restarting', 'running', 'stopping', 'failed'];

const DEFAULT_LOG_LINES = 500;
const STOP_GRACE_MS = 8_000;
const RESTART_BACKOFF_MS = [1_000, 5_000, 15_000, 30_000, 60_000];
const MAX_RESTARTS = 5;

function portIsFree(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function freePort(host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function probeHealth(url) {
  return new Promise((resolve) => {
    const request = globalThis.fetch(url, { signal: AbortSignal.timeout(1_500) });
    request.then((response) => resolve(response.ok)).catch(() => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GatewaySupervisor extends EventEmitter {
  constructor(options) {
    super();
    this.options = {
      host: '127.0.0.1',
      healthPath: '/health',
      readinessTimeoutMs: 30_000,
      readinessPollMs: 250,
      logLines: DEFAULT_LOG_LINES,
      fallbackToFreePort: false,
      autoRestart: false,
      maxRestarts: MAX_RESTARTS,
      restartBackoffMs: RESTART_BACKOFF_MS,
      ...options,
    };
    if (!this.options.projectRoot) throw new Error('projectRoot is required');
    if (!this.options.entry) throw new Error('entry is required');
    if (!Number.isInteger(this.options.port)) throw new Error('port is required');
    this.state = 'stopped';
    this.child = undefined;
    this.logs = [];
    this.lastError = undefined;
    this.startedAt = undefined;
    this.restarts = 0;
    this.restartTimer = undefined;
    this.expectedExit = false;
  }

  get port() {
    return this.options.port;
  }

  snapshot() {
    return {
      state: this.state,
      host: this.options.host,
      port: this.options.port,
      pid: this.child?.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      restarts: this.restarts,
      logs: [...this.logs],
    };
  }

  setState(state, detail) {
    if (!STATES.includes(state)) throw new Error(`unknown supervisor state ${state}`);
    this.state = state;
    if (detail) this.lastError = detail;
    this.emit('state', this.snapshot());
  }

  pushLog(stream, chunk) {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      this.logs.push({ at: new Date().toISOString(), stream, line });
      if (this.logs.length > this.options.logLines) this.logs.shift();
      this.emit('log', this.logs[this.logs.length - 1]);
    }
  }

  /**
   * The port this launch will use. 8787 is the documented default, not a requirement: another local
   * gateway, or anything else on that port, must not stop the app from opening. A fallback port is
   * announced through the snapshot so the renderer and IPC client follow it.
   */
  async resolvePort() {
    if (await portIsFree(this.options.port, this.options.host)) return this.options.port;
    if (!this.options.fallbackToFreePort) return this.options.port;
    const fallback = await freePort(this.options.host);
    this.pushLog('stdout', `Port ${this.options.port} is in use; using ${fallback}.\n`);
    this.options.port = fallback;
    return fallback;
  }

  async start(automatic = false) {
    if (this.state === 'running' || this.state === 'starting') return this.snapshot();
    if (this.state === 'restarting' && !automatic) return this.snapshot();
    if (this.state === 'stopping') throw new Error('The gateway is still stopping.');
    this.lastError = undefined;
    this.expectedExit = false;
    if (!automatic) this.restarts = 0;

    await this.resolvePort();
    if (!(await portIsFree(this.options.port, this.options.host))) {
      const message = `Port ${this.options.port} is already in use.`;
      this.setState('failed', message);
      throw new Error(message);
    }

    this.setState('starting');
    const spawn = this.options.spawn ?? nodeSpawn;
    const child = spawn(this.options.execPath ?? process.execPath, [this.options.entry], {
      // A packaged app's own directory is `app.asar`, which is not a valid `cwd`. The resources
      // directory is the real filesystem path beside it.
      cwd: this.options.cwd ?? this.options.projectRoot,
      env: {
        ...process.env,
        ...this.options.env,
        OMNIHILBRAS_HOST: this.options.host,
        OMNIHILBRAS_PORT: String(this.options.port),
        // Electron's binary is Node only when this is set. Harmless for a plain Node test process.
        ELECTRON_RUN_AS_NODE: '1',
      },
      // Not detached: the app owns this process, and a group id is only useful to a launcher that has
      // to survive its own exit. Electron kills the child on quit through `stop()`.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk) => this.pushLog('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.pushLog('stderr', chunk));
    child.once('error', (error) => {
      this.pushLog('stderr', `Could not start the gateway: ${error.message}\n`);
      if (this.child === child) {
        this.child = undefined;
        this.setState('failed', error.message);
      }
    });

    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    this.childExit = exited;

    exited.then(({ code, signal }) => {
      if (this.child !== child) return;
      const expected = this.expectedExit || this.state === 'stopping' || this.state === 'stopped';
      this.child = undefined;
      this.startedAt = undefined;
      if (expected) return;
      this.scheduleRestart(`The gateway exited (code ${code ?? signal ?? 'unknown'}).`);
    });

    const deadline = Date.now() + this.options.readinessTimeoutMs;
    const url = `http://${this.options.host}:${this.options.port}${this.options.healthPath}`;
    while (Date.now() < deadline) {
      if (this.child !== child) {
        throw new Error(this.lastError ?? 'The gateway exited before it became ready.');
      }
      if (await probeHealth(url)) {
        this.startedAt = new Date().toISOString();
        this.setState('running');
        return this.snapshot();
      }
      await sleep(this.options.readinessPollMs);
    }

    await this.stop();
    const message = `The gateway did not answer on port ${this.options.port} within ${Math.round(this.options.readinessTimeoutMs / 1000)}s.`;
    this.setState('failed', message);
    throw new Error(message);
  }

  scheduleRestart(reason) {
    if (!this.options.autoRestart) {
      this.setState('failed', reason);
      return;
    }
    if (this.restarts >= this.options.maxRestarts) {
      this.setState('failed', `${reason} Restart limit reached.`);
      return;
    }
    const delay = this.options.restartBackoffMs[Math.min(this.restarts, this.options.restartBackoffMs.length - 1)];
    this.restarts += 1;
    this.setState('restarting', `${reason} Restarting in ${Math.round(delay / 1000)}s (${this.restarts}/${this.options.maxRestarts}).`);
    this.pushLog('stderr', `${reason} Restarting in ${Math.round(delay / 1000)}s.\n`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start(true).catch((error) => {
        this.setState('failed', error instanceof Error ? error.message : String(error));
      });
    }, delay);
  }

  async stop() {
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.expectedExit = true;
    const child = this.child;
    if (!child) {
      if (this.state !== 'failed') this.setState('stopped');
      return this.snapshot();
    }
    this.setState('stopping');
    const platform = this.options.platform ?? process.platform;
    if (platform === 'win32') {
      // `child.kill()` on Windows terminates only the process we spawned. `taskkill /T` reaches the
      // tree, which is what a packaged gateway can become once a provider helper is involved.
      const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise((resolve) => killer.once('exit', resolve));
    } else {
      child.kill('SIGTERM');
    }
    const exited = await Promise.race([
      this.childExit.then(() => true),
      sleep(STOP_GRACE_MS).then(() => false),
    ]);
    if (!exited) child.kill('SIGKILL');
    await this.childExit.catch(() => undefined);
    this.child = undefined;
    this.startedAt = undefined;
    this.restarts = 0;
    this.setState('stopped');
    return this.snapshot();
  }

  async restart() {
    await this.stop();
    return this.start();
  }
}

export function createGatewaySupervisor(options) {
  return new GatewaySupervisor(options);
}

