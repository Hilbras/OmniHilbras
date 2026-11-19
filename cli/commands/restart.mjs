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
    // First thing on restart: check for a newer release, like the reference launcher does at every launch.
    // Fail-open and opt-in — it only notices; installing stays the explicit `omnihilbras update`.
    if (!flags.skipUpdate) {
      const updateInfo = await checkForUpdate(version).catch(() => undefined);
      if (updateInfo?.updateAvailable) {
        out.line(out.warn(`Update available: ${updateInfo.current} → ${updateInfo.latest}. Run \`omnihilbras update\` to install it.`));
      }
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

    if (!hasBundledServer()) {
      throw new CliError('This install has no bundled server to start.', { hint: 'Reinstall @hilbras/omnihilbras, or start the servers from the desktop app.' });
    }
    out.line(out.muted('Restarting the bundled servers…'));
    return await runBundledServer([]);
  },
};
