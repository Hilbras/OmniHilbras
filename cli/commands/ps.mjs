/**
 * `omnihilbras ps` — what the bundled launcher is running right now.
 *
 * Distinct from `status`, which asks a *gateway* what it is: `ps` asks the *run record* which processes were
 * started, whether they are still alive and still ours, their ports and uptime, and then adds the gateway's
 * own health when it answers. A pid that is alive but no longer recognisably ours is reported as `foreign`,
 * not silently treated as running — the same ownership rule `stop` enforces.
 */

import { readBundledRecord, isPidAlive, commandLineForPid, looksLikeOurServer } from '../lib/bundled-state.mjs';

export const ps = {
  name: 'ps',
  summary: 'Show the bundled run: pids, ports, uptime, ownership',
  usage: 'omnihilbras ps [--json]',
  flags: [],
  async run({ client, out }) {
    const record = readBundledRecord();
    if (!record) {
      out.data({ running: false, processes: [] });
      out.line(out.muted('No bundled run is recorded. Start one with `omnihilbras`.'));
      return 0;
    }

    const processes = [['gateway', record.gatewayPid], ['dashboard', record.staticPid]].map(([role, pid]) => {
      const alive = Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid);
      const command = alive ? commandLineForPid(pid) : '';
      return { role, pid, alive, owned: alive ? looksLikeOurServer(command) : false, command };
    });
    const running = processes.some((entry) => entry.alive && entry.owned);
    const uptimeSeconds = record.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(record.startedAt)) / 1000)) : undefined;

    let gateway = null;
    try {
      const health = await client.request('/health');
      gateway = { status: health.status, version: health.build?.version };
    } catch {
      gateway = null;
    }

    out.data({ running, dashboardPort: record.dashboardPort, gatewayPort: record.gatewayPort, startedAt: record.startedAt, uptimeSeconds, processes, gateway });
    if (out.json) return 0;

    out.title(running ? 'Bundled servers running' : 'Bundled servers not running');
    out.line(`  ${out.muted('dashboard')}  http://localhost:${record.dashboardPort}/dashboard`);
    out.line(`  ${out.muted('gateway')}    http://127.0.0.1:${record.gatewayPort}`);
    if (uptimeSeconds !== undefined) out.line(`  ${out.muted('uptime')}     ${uptimeSeconds}s`);
    out.table(processes.map((entry) => [entry.role, String(entry.pid), entry.alive ? (entry.owned ? 'ours' : 'foreign') : 'dead']), ['role', 'pid', 'state']);
    if (gateway) out.line(`  ${out.muted('health')}     ${gateway.status} · ${gateway.version ?? ''}`);
    return 0;
  },
};
