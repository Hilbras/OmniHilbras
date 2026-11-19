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
 * signalled.** A pid can outlive its process and be reused, so a record alone is never authority to kill.
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

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

/**
 * Whether a command line is one of the servers this launcher starts. The two bundled servers are
 * `gateway.mjs` and `static.mjs`; matching their filenames (not merely "node") is what keeps a reused pid
 * that happens to be some other Node process from being killed.
 */
export function looksLikeOurServer(commandLine) {
  return /gateway\.mjs|static\.mjs/.test(commandLine ?? '');
}

/**
 * Stops the recorded servers, verifying each pid is still ours first.
 *
 * Returns what happened rather than acting on the record blindly: `stopped` (signalled), `gone` (already
 * dead), and `refused` (alive but not recognisably ours — a reused or foreign pid, left alone unless `force`).
 * The caller waits for exit and decides whether to clear the record; a refusal is reported, never hidden.
 * `kill`/`alive`/`commandLine` are injectable so a test can drive the decision without real processes.
 */
export function stopBundledServers(record, options = {}) {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const alive = options.alive ?? isPidAlive;
  const commandLine = options.commandLine ?? ((pid) => commandLineForPid(pid));
  const force = options.force ?? false;
  const pids = [record?.gatewayPid, record?.staticPid].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const stopped = [];
  const gone = [];
  const refused = [];
  for (const pid of pids) {
    if (!alive(pid)) {
      gone.push(pid);
      continue;
    }
    const cmd = commandLine(pid) ?? '';
    if (!force && !looksLikeOurServer(cmd)) {
      refused.push({ pid, command: cmd });
      continue;
    }
    try {
      kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch {
      gone.push(pid);
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
