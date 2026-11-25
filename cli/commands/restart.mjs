/**
 * `omnihilbras restart` — stop the bundled servers, then start them again.
 *
 * The stop half is ownership-verified exactly like `stop`; if a recorded pid cannot be attributed it is left
 * alone and the restart is refused rather than killing something foreign and starting a second copy. The
 * start half hands the terminal to the bundled launcher, which owns the menu, spinner and Ctrl-C.
 */

import { createRequire } from 'node:module';
import { CliError } from '../lib/client.mjs';
import { readBundledRecord, stopBundledServers, waitPidGone, clearBundledRecord } from '../lib/bundled-state.mjs';
import { hasBundledServer, runBundledServer } from '../lib/bundled.mjs';
import { checkForUpdate } from '../lib/update.mjs';

const { version } = createRequire(import.meta.url)('../package.json');

export const restart = {
  name: 'restart',
  summary: 'Check for an update, then stop and start the bundled servers',
  usage: 'omnihilbras restart [--force] [--skip-update]',
  flags: ['--force', '--skip-update'],
  async run({ out, flags }) {
    if (out.json) {
      throw new CliError('`restart --json` is not supported because the launcher owns the terminal session.', {
        code: 2,
        hint: 'Run `omnihilbras restart` without --json, or query `omnihilbras ps --json` afterwards.',
      });
    }
    // First thing on restart: check for a newer release, like the reference launcher does at every launch.
    // Fail-open and opt-in — it only notices; installing stays the explicit `omnihilbras update`.
    if (!flags.skipUpdate) {
      const updateInfo = await checkForUpdate(version).catch(() => undefined);
      if (updateInfo?.updateAvailable) {
        out.line(out.warn(`Update available: ${updateInfo.current} → ${updateInfo.latest}. Run \`omnihilbras update\` to install it.`));
      }
    }

    // Preflight before stopping: a broken install must not take down a healthy run.
    if (!hasBundledServer()) {
      throw new CliError('This install has no bundled server to start.', { hint: 'Reinstall @hilbras/omnihilbras, or start the servers from the desktop app.' });
    }

    const record = readBundledRecord();
    if (record) {
      const result = stopBundledServers(record, { force: Boolean(flags.force) });
      for (const pid of result.stopped) {
        if (!(await waitPidGone(pid, 2000))) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          await waitPidGone(pid, 1000);
        }
      }
      if (result.refused.length > 0) {
        out.data({ restarted: false, refused: result.refused });
        throw new CliError('Some recorded pids are not recognisably ours; they were left alone.', { hint: 'Inspect with `omnihilbras ps`, or re-run with --force.' });
      }
      clearBundledRecord();
    }

const argv = [];
    if (record) {
      argv.push('--port', String(record.dashboardPort), '--gateway-port', String(record.gatewayPort));
      if (record.background) argv.push('--background');
    }
    if (flags.skipUpdate) argv.push('--skip-update');
    out.line(out.muted('Restarting the bundled servers...'));
    return await runBundledServer(argv);
  },
};
