import { startGatewayServer } from './server.js';
import { ensureOpencodeService, opencodeServiceMode, resolveOpencodeBinary, startOpencodeSupervisor, stopOpencodeService } from './core/opencode-runtime.js';

/**
 * Shutdown state, declared before anything can fail.
 *
 * The listeners used to be registered *after* `await startGatewayServer()`, which left roughly the first
 * 1.5 seconds of every boot with Node's default SIGTERM disposition — the signal terminates the process
 * outright, with no drain and no cleanup. Measured against the real binary:
 *
 * ```
 * SIGTERM after  0.05s -> DEFAULT-KILLED (-15)
 * SIGTERM after  0.50s -> DEFAULT-KILLED (-15)
 * SIGTERM after  1.00s -> DEFAULT-KILLED (-15)
 * SIGTERM after  2.00s -> handled (0)
 * ```
 *
 * That window is not hypothetical for a container: an orchestrator that replaces a pod while the old one
 * is still booting sends SIGTERM straight into it, and the exit becomes a hard kill rather than the
 * graceful shutdown the rest of this file implements. Startup does real work — config, the stores, the
 * first health sweep — so 1.5s is not a pessimistic estimate; it is what this binary took.
 *
 * So the handlers go in first, and hold a promise that startup fills in. A signal arriving before the
 * server exists waits for it rather than killing the process.
 */
let instance: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let shuttingDown = false;
/**
 * Assigned once the server is up, and a no-op before that.
 *
 * Declared here rather than next to its assignment because a SIGTERM can arrive between the server starting
 * and the supervisor existing — a `const` read before its assignment throws, and this runs inside the shutdown
 * path, which is the worst place to discover that.
 */
let stopSupervisor: () => void = () => {};
let markReady: () => void = () => {};
const ready = new Promise<void>((resolve) => { markReady = resolve; });

const close = (code: number) => {
  /**
   * The OpenCode instance this gateway owns is stopped here, and only if we started it.
   *
   * Before this, nothing stopped it: the service was borrowed, so leaving it running was the rule. An
   * instance we own is part of our server, and a server that leaves a child behind after it exits is a
   * process the next start has to guess about. `stopOpencodeService` reads our own pid file and checks
   * the command line before signalling, so the user's own OpenCode app is never touched.
   *
   * Started here so it runs *alongside* the drain, and awaited before the exit — not fired and forgotten.
   * The first version was `void stopOpencodeService()`, and it never stopped anything: the drain finishes in
   * a few milliseconds, `process.exit` runs, and the pending `readFile`/`kill` work died with the process.
   * Measured: the instance was still alive and still listening after the gateway exited.
   *
   * Its wait is bounded internally (SIGTERM, then up to five seconds, then SIGKILL), so awaiting it cannot
   * outlast the drain's own five-second deadline by much.
   */
  const stoppingService = stopOpencodeService().catch(() => undefined);
  // The supervisor stops first, so it cannot start a fresh instance while this one is being stopped.
  stopSupervisor();

  // The server stops accepting first, then the service drains. That order is the contract: the
  // key store's drain loops until nothing is in flight, which terminates on an idle queue and not
  // on a busy one, so it must not run while requests are still arriving.
  const server = instance!.server;
  server.close(() => {
    void stoppingService.then(() => instance!.service.close()).then(() => process.exit(code));
  });
  // A log stream or an open SSE answer never becomes idle, so `server.close()` waits forever and the
  // drain never starts. Idle sockets are dropped at once; anything still open gets a bounded grace
  // period, after which it is closed and the callback can run.
  server.closeIdleConnections?.();
  const deadline = setTimeout(() => server.closeAllConnections?.(), 5_000);
  deadline.unref();
};

const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    // A second signal means the operator has decided: stop waiting for a drain and go now. With the old
    // `process.once` the second Ctrl-C was silently discarded, so a process stuck draining looked hung
    // and the only way out was SIGKILL from another terminal.
    console.error(`OmniHilbras gateway: ${signal} again, exiting immediately.`);
    process.exit(1);
  }
  shuttingDown = true;
  if (!instance) {
    console.error(`OmniHilbras gateway: ${signal} during startup, waiting for it to finish.`);
    void ready.then(() => close(0));
    return;
  }
  close(0);
};

// Registered before startup, so the whole boot window is covered.
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

instance = await startGatewayServer();
markReady();

/**
 * Our OpenCode instance starts with the gateway, and is kept running afterwards.
 *
 * The provider used to be lazy: `auto` started the service when a request needed it, so the state a
 * person saw in the dashboard was "installed, not running" and pressing a button was the only way to
 * find out it worked. A server that owns a dependency should start it — the browser surface then reports
 * a running service because it *is* running.
 *
 * Off by request, and silent when there is nothing to start: `OMNIHILBRAS_OPENCODE_SERVICE=off` means
 * "never", and a machine with no runtime at all is a state the dashboard reports rather than an error a
 * boot should fail on. Starting it does not block the server: the gateway is already accepting.
 */
void (async () => {
  try {
    if (opencodeServiceMode() === 'off') return;
    if (!(await resolveOpencodeBinary())) return;
    await ensureOpencodeService();
  } catch (error) {
    // A runtime that will not start is the provider's problem, reported when it is used, not a reason for
    // the gateway to die at boot.
    console.error(`OmniHilbras gateway: the OpenCode runtime did not start. ${error instanceof Error ? error.message : String(error)}`);
  }
})();

/**
 * And it stays running while the gateway does.
 *
 * Opening OpenCode kills our instance — its service reaps whatever the canonical registration names, and
 * registering there is what the free tier requires — so without this the provider stayed pointed at a dead
 * port until somebody restarted the gateway. The supervisor starts ours only when nothing is live, so the
 * app wins whenever it is open and ours returns when it closes; it never reaps the app's instance.
 */
stopSupervisor = startOpencodeSupervisor();
console.log(`OmniHilbras gateway listening on http://${instance.config.host}:${instance.config.port}`);
