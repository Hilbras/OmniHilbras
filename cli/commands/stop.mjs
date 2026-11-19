/**
 * `omnihilbras stop` — stop the bundled gateway and dashboard this command started.
 *
 * Local process control, not a gateway call: it reads the run record the launcher wrote and signals exactly
 * those pids, **after verifying each is still ours**. A pid can be reused, so a record alone is never
 * authority to kill — a foreign or reused pid is reported and left alone unless `--force`. This is the
 * counterpart to the launcher's Ctrl-C, for when the servers were started in another terminal (or, later,
 * in the background).
 */

import { CliError } from '../lib/client.mjs';
import { readBundledRecord, stopBundledServers, waitPidGone, clearBundledRecord, isPidAlive } from '../lib/bundled-state.mjs';

export const stop = {
  name: 'stop',
  summary: 'Stop the bundled gateway and dashboard',
  usage: 'omnihilbras stop [--force] [--json]',
  flags: ['--force'],
  async run({ out, flags }) {
    const record = readBundledRecord();
    if (!record) {
      out.data({ running: false, stopped: [], alreadyGone: [], refused: [] });
      out.line(out.muted('Nothing to stop — no bundled run is recorded. Start one with `omnihilbras`.'));
      return 0;
    }

    const result = stopBundledServers(record, { force: Boolean(flags.force) });
    for (const pid of result.stopped) {
      if (!(await waitPidGone(pid, 2000))) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        await waitPidGone(pid, 1000);
      }
    }
    // Only forget the run when nothing was refused; a refusal means a pid we could not attribute, and the
    // record is kept so `ps` can still show it rather than silently orphaning it.
    if (result.refused.length === 0) clearBundledRecord();

    out.data({ running: false, stopped: result.stopped, alreadyGone: result.gone, refused: result.refused, recordCleared: result.refused.length === 0 });
    if (out.json) return result.refused.length > 0 ? 1 : 0;

    if (result.refused.length > 0) {
      out.line(out.warn('These recorded pids are not recognisably ours, so they were left alone:'));
      out.table(result.refused.map((entry) => [String(entry.pid), String(entry.command).slice(0, 70)]), ['pid', 'command']);
      out.line(out.muted('Inspect them with `omnihilbras ps`, or re-run with --force to stop them anyway.'));
      return 1;
    }
    out.title('Stopped the bundled gateway and dashboard.');
    return 0;
  },
};
