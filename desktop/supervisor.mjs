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

export const STATES = ['stopped', 'starting', 'running', 'stopping', 'failed'];

const DEFAULT_LOG_LINES = 500;
const STOP_GRACE_MS = 8_000;

function portIsFree(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
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
  }

  snapshot() {
    return {
      state: this.state,
      host: this.options.host,
      port: this.options.port,
      pid: this.child?.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
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

  async start() {
    if (this.state === 'running' || this.state === 'starting') return this.snapshot();
    if (this.state === 'stopping') throw new Error('The gateway is still stopping.');
    this.lastError = undefined;

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
      const expected = this.state === 'stopping' || this.state === 'stopped';
      this.child = undefined;
      this.startedAt = undefined;
      if (expected) return;
      this.setState('failed', `The gateway exited (code ${code ?? signal ?? 'unknown'}).`);
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

  async stop() {
    const child = this.child;
    if (!child) {
      if (this.state !== 'failed') this.setState('stopped');
      return this.snapshot();
    }
    this.setState('stopping');
    child.kill('SIGTERM');
    const exited = await Promise.race([
      this.childExit.then(() => true),
      sleep(STOP_GRACE_MS).then(() => false),
    ]);
    if (!exited) {
      child.kill('SIGKILL');
      await this.childExit.catch(() => undefined);
    }
    this.child = undefined;
    this.startedAt = undefined;
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
