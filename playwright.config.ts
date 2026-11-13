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
  const output = execFileSync(
    process.execPath,
    ['-e', "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"],
    { encoding: 'utf8' },
  );
  return Number(output.trim());
}

const port = Number(process.env.E2E_PORT) || freePort();
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
        command: `pnpm preview --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
