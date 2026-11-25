/**
 * The bundled launcher's run record — one definition, shared by the launcher and the lifecycle verbs.
 *
 * `cli/server-src/main.mjs` writes `$XDG_STATE_HOME/omnihilbras/bundled.json` when it starts the gateway and
 * the dashboard, so a later `omnihilbras stop|restart|open|ps` can find exactly the processes it started.
 * That path and the "is this pid still ours?" check used to live only inside the launcher; a verb that
 * re-derived them was a second copy waiting to drift, which is how a CLI and a server come to disagree about
 * one fact. So both read it from here, and `tests/cli-lifecycle.test.js` pins that the launcher imports this
 * module rather than re-declaring the path.
 *
 * The rule the launcher already follows holds here too: **a pid is verified to be ours before it is
 * signalled, and re-verified immediately before an uncatchable signal.** A pid can outlive its process and
 * be reused, so a record alone is never authority to kill. Ownership is never decided by a generic runtime
 * name (`node`, `vite`, `pnpm`): it is decided by the server file the process was started from, or by the
 * exact absolute install path when one is supplied.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Mirrors the launcher's own resolution exactly; the launcher imports this so there is only one. */
export function bundledStateDir(env = process.env) {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'omnihilbras')
    : path.join(os.homedir(), '.local', 'state', 'omnihilbras');
}

export function bundledRecordPath(env = process.env) {
  return path.join(bundledStateDir(env), 'bundled.json');
}

/** The recorded run, or undefined when nothing has been started (or the file is unreadable). */
export function readBundledRecord(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(bundledRecordPath(env), 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeBundledRecord(record, env = process.env) {
  const file = bundledRecordPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function clearBundledRecord(env = process.env) {
  try {
    fs.unlinkSync(bundledRecordPath(env));
  } catch {
    /* nothing to clear */
  }
}

/** Removes the record only when it still describes `runId`, so an older launcher cannot delete a newer run. */
export function clearBundledRecordIf(runId, env = process.env) {
  const record = readBundledRecord(env);
  if (record && runId !== undefined && record.runId === runId) clearBundledRecord(env);
}

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The command line of a pid, for the ownership decision and for a message. Never throws. */
export function commandLineForPid(pid, { platform = process.platform, procRoot = '/proc' } = {}) {
  if (platform === 'linux') {
    try {
      return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0').join(' ').trim();
    } catch {
      /* fall through to ps */
    }
  }
  if (platform === 'win32') {
    // Windows has no `ps`; without this branch the ownership check always fails and the launcher cannot stop
    // its own recorded servers (code review, 2026-11-20). `tasklist` gives only the image name (node.exe),
    // which cannot identify gateway.mjs vs static.mjs, so ask WMI for the full command line.
    try {
      const output = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      return output.trim();
    } catch {
      return '';
    }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

/**
 * The exact server files an installation stages next to its launcher.
 *
 * The launcher imports this so the paths it verifies are the paths it spawned, and a verb imports it so the
 * paths it verifies are the paths that installation would have spawned. `OMNIHILBRAS_BUNDLED_SERVER` moves the
 * whole set, which is what lets a test point at a stand-in.
 */
export function bundledRuntimePaths(serverPath) {
  const main = path.resolve(serverPath);
  const directory = path.dirname(main);
  return {
    main,
    supervisorPaths: [main],
    serverPaths: [path.join(directory, 'gateway.mjs'), path.join(directory, 'static.mjs')],
  };
}

const asPosix = (value) => String(value ?? '').replace(/\\/g, '/');

/**
 * Whether a command line is one of the servers this launcher starts.
 *
 * With `serverPaths` (absolute files this install staged) the test is an exact path containment: a process
 * running some *other* checkout's `gateway.mjs` is not ours. Without them — a fabricated record in a test, or
 * a platform where only the command line is available — it is the exact filename token, never a generic
 * runtime name. `node`, `vite` and `pnpm` are deliberately absent: those matched every Node app on the
 * machine, so a typo in `--port` could kill an unrelated editor.
 */
export function looksLikeOurServer(commandLine, { serverPaths = [] } = {}) {
  const line = String(commandLine ?? '');
  if (!line.trim()) return false;
  if (serverPaths.length > 0) {
    const normalized = asPosix(line);
    return serverPaths.some((serverPath) => {
      const target = asPosix(serverPath).replace(/\/+$/, '');
      return target !== '' && normalized.includes(target);
    });
  }
  return /(?:^|[\s"'=(\/\\])(?:gateway|static)\.mjs(?=$|[\s"'),;])/m.test(line);
}

/** The launcher itself, which supervises the two servers and must be stopped before them. */
export function looksLikeOurSupervisor(commandLine, { serverPaths = [] } = {}) {
  const line = String(commandLine ?? '');
  if (!line.trim()) return false;
  if (serverPaths.length > 0) {
    const normalized = asPosix(line);
    return serverPaths.some((serverPath) => {
      const target = asPosix(serverPath).replace(/\/+$/, '');
      return target !== '' && normalized.includes(target);
    });
  }
  return /(?:^|[\s"'=(\/\\])server\/main\.mjs(?=$|[\s"'),;])/m.test(line);
}

/**
 * Every process a record names, in the order they must be stopped.
 *
 * The supervisor (the launcher that respawns a crashed child) comes first: signalling a child while its
 * supervisor is alive lets the supervisor read a deliberate stop as a crash and start a second copy.
 */
export function recordedPids(record) {
  const entries = [];
  const add = (role, pid, supervisor = false) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    if (entries.some((entry) => entry.pid === pid)) return;
    entries.push({ role, pid, supervisor });
  };
  add('supervisor', record?.supervisorPid, true);
  add('gateway', record?.gatewayPid);
  add('dashboard', record?.staticPid);
  return entries;
}

/**
 * Stops the recorded servers, verifying each pid is still ours first.
 *
 * Returns what happened rather than acting on the record blindly: `stopped` (signalled), `gone` (already
 * dead), and `refused` (alive but not recognisably ours — a reused or foreign pid, left alone unless `force`).
 * The caller waits for exit and decides whether to clear the record; a refusal is reported, never hidden.
 * `kill`/`alive`/`commandLine` are injectable so a test can drive the decision without real processes.
 * The synchronous form only *sends* the signals; `terminateBundledServers` is what waits, revalidates and
 * escalates.
 */
export function stopBundledServers(record, options = {}) {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const alive = options.alive ?? isPidAlive;
  const commandLine = options.commandLine ?? ((pid) => commandLineForPid(pid));
  const force = options.force ?? false;
  const serverPaths = options.serverPaths ?? [];
  const supervisorPaths = options.supervisorPaths ?? [];
  const skip = new Set(options.skipPids ?? []);
  const stopped = [];
  const gone = [];
  const refused = [];
  for (const entry of recordedPids(record)) {
    if (skip.has(entry.pid)) continue;
    if (!alive(entry.pid)) {
      gone.push(entry.pid);
      continue;
    }
    const cmd = commandLine(entry.pid) ?? '';
    const ours = entry.supervisor
      ? looksLikeOurSupervisor(cmd, { serverPaths: supervisorPaths })
      : looksLikeOurServer(cmd, { serverPaths });
    if (!force && !ours) {
      refused.push({ pid: entry.pid, role: entry.role, command: cmd });
      continue;
    }
    try {
      kill(entry.pid, 'SIGTERM');
      stopped.push(entry.pid);
    } catch {
      gone.push(entry.pid);
    }
  }
  return { stopped, gone, refused };
}

/** Waits until a pid is gone, or the timeout passes. Returns whether it is gone. */
export async function waitPidGone(pid, timeoutMs = 2000, alive = isPidAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

/**
 * Stops one pid, and only one pid.
 *
 * SIGTERM first, then a wait, and **the command line is read again immediately before SIGKILL**. A process
 * that exited during the wait releases its pid, and that pid can belong to something else by the time the
 * escalation runs; signalling on the strength of the first reading is how a launcher kills an unrelated
 * process. A second reading that is not ours means the first process is gone and this is not it, so the
 * escalation is refused and reported.
 */
export async function terminatePid(pid, options = {}) {
  const alive = options.alive ?? isPidAlive;
  const kill = options.kill ?? ((target, signal) => process.kill(target, signal));
  const commandLine = options.commandLine ?? ((target) => commandLineForPid(target));
  const force = options.force ?? false;
  const supervisor = options.supervisor ?? false;
  const serverPaths = supervisor ? (options.supervisorPaths ?? []) : (options.serverPaths ?? []);
  const waitMs = options.waitMs ?? 2000;
  const graceMs = options.graceMs ?? 1000;
  const owned = (line) => (supervisor ? looksLikeOurSupervisor(line, { serverPaths }) : looksLikeOurServer(line, { serverPaths }));

  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid, stopped: false, refused: true, reason: 'invalid-pid' };
  if (!alive(pid)) return { pid, stopped: false, gone: true };

  const first = commandLine(pid) ?? '';
  if (!force && !owned(first)) return { pid, stopped: false, refused: true, command: first };

  try {
    kill(pid, 'SIGTERM');
  } catch {
    return { pid, stopped: false, gone: true };
  }
  if (await waitPidGone(pid, waitMs, alive)) return { pid, stopped: true, killed: false };

  const second = commandLine(pid) ?? '';
  if (!force && !owned(second)) {
    return { pid, stopped: true, killed: false, refused: true, command: second, reason: 'revalidated-foreign' };
  }
  try {
    kill(pid, 'SIGKILL');
  } catch {
    return { pid, stopped: true, killed: true };
  }
  const gone = await waitPidGone(pid, graceMs, alive);
  return { pid, stopped: true, killed: true, alive: !gone };
}

/**
 * Stops every process a record names, supervisor first, with the escalation guarded by a second ownership
 * check. Returns one outcome per recorded pid so a caller can report exactly what happened.
 */
export async function terminateBundledServers(record, options = {}) {
  const skip = new Set(options.skipPids ?? []);
  const results = [];
  for (const entry of recordedPids(record)) {
    if (skip.has(entry.pid)) continue;
    const outcome = await terminatePid(entry.pid, { ...options, supervisor: entry.supervisor });
    results.push({ role: entry.role, ...outcome });
  }
  return {
    results,
    stopped: results.filter((entry) => entry.stopped).map((entry) => entry.pid),
    gone: results.filter((entry) => entry.gone).map((entry) => entry.pid),
    refused: results.filter((entry) => entry.refused).map((entry) => ({ pid: entry.pid, role: entry.role, command: entry.command ?? '', reason: entry.reason })),
    survivors: results.filter((entry) => entry.alive).map((entry) => entry.pid),
  };
}