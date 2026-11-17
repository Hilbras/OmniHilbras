import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

/**
 * The e2e server never takes a main port.
 *
 * The dev servers own 20137 (dashboard) and 20138 (gateway). A test run asking for either would
 * collide with a running dev server, so it asks the OS for a free one instead — `E2E_PORT` overrides
 * it when a fixed port is wanted.
 */
function freePort(): number {
  /**
   * The number is read out of a colourised line, which `Number` cannot parse.
   *
   * Measured here: the probe returned `"\u001b[33m44815\u001b[39m\n"` because this shell asks for colour, so
   * `Number(output.trim())` was `NaN`, `baseURL` became `http://127.0.0.1:NaN`, and every spec failed with
   * "Cannot navigate to invalid URL" before a page loaded. The same trap is invisible where colour is off, which is
   * why CI picked a port happily while a local run could not. Colour is switched off for the child and the digits are
   * read out of whatever comes back, so neither behaviour can decide the port.
   */
  const output = execFileSync(
    process.execPath,
    ['-e', "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"],
    { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } },
  );
  const digits = /(\d+)/.exec(output.replace(/\u001b\[[0-9;]*m/g, ''))?.[1];
  const port = Number(digits);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`the free-port probe answered ${JSON.stringify(output)}`);
  return port;
}

/**
 * One port for the run, chosen once.
 *
 * Playwright evaluates this file in the runner **and again in every worker**, so a probe that picks a free port
 * returned a different number in each process: the server was started on one (`--port 37093`) and the spec navigated
 * to another (`ERR_CONNECTION_REFUSED at http://127.0.0.1:40901`). Publishing the choice into `E2E_PORT` makes the
 * worker's own evaluation read the number the server is actually on, which is also the variable the `--list` path and
 * a manual `E2E_PORT=…` run already use.
 */
const chosenPort = Number(process.env.E2E_PORT) || freePort();
if (!process.env.E2E_PORT) process.env.E2E_PORT = String(chosenPort);
const port = chosenPort;
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        /**
         * `--host 127.0.0.1`, because `baseURL` is `127.0.0.1` and Vite's default is `localhost`.
         *
         * The two agree wherever `localhost` resolves to IPv4 first. Where it resolves to `::1` first, Vite binds the
         * IPv6 address only and `http://127.0.0.1:<port>` refuses — measured here with `--host ::1`: `127.0.0.1`
         * answered `000` while `[::1]` answered `200`. A refused connection is not a startup error to Playwright; it
         * waits out the timeout and reports "Timed out waiting from config.webServer", which names neither the address
         * nor the resolver. Naming the address removes the ambiguity. This is not a proven diagnosis of any particular
         * CI failure — it is the one address the suite is asking for.
         */
        command: `pnpm preview --host 127.0.0.1 --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
