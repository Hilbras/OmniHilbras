/**
 * `omnihilbras open` — open the running bundled dashboard in a browser.
 *
 * Uses the port from the run record, never a guess: a dashboard on a non-default `--port` is opened at the
 * port it actually listens on. When nothing is running it says so rather than opening a dead URL.
 */

import { spawn } from 'node:child_process';
import { CliError } from '../lib/client.mjs';
import { readBundledRecord, isPidAlive } from '../lib/bundled-state.mjs';

export const open = {
  name: 'open',
  summary: 'Open the running dashboard in a browser',
  usage: 'omnihilbras open [--json]',
  flags: [],
  async run({ out }) {
    const record = readBundledRecord();
    const port = record?.dashboardPort;
    const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
    const alive = Number.isSafeInteger(record?.staticPid) && record.staticPid > 0 && isPidAlive(record.staticPid);
    if (!validPort || !alive) {
      out.data({ opened: false, url: null });
      throw new CliError('No bundled dashboard is running.', { hint: 'Start one with `omnihilbras`, then `omnihilbras open`.' });
    }
    const url = `http://localhost:${port}/dashboard`;
    out.data({ opened: true, url });

    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd') : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {
      out.line(out.muted(`Could not open a browser — open ${url} yourself.`));
    }).unref();

    out.line(`Opening ${url}`);
    return 0;
  },
};
