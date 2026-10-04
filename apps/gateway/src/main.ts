import { startGatewayServer } from './server.js';

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
let markReady: () => void = () => {};
const ready = new Promise<void>((resolve) => { markReady = resolve; });

const close = (code: number) => {
  // The server stops accepting first, then the service drains. That order is the contract: the
  // key store's drain loops until nothing is in flight, which terminates on an idle queue and not
  // on a busy one, so it must not run while requests are still arriving.
  instance!.server.close(() => {
    void instance!.service.close().then(() => process.exit(code));
  });
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
console.log(`OmniHilbras gateway listening on http://${instance.config.host}:${instance.config.port}`);
