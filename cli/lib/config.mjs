/**
 * Where the CLI talks to, and what it talks with.
 *
 * Shared by every verb, and the only place either is decided — the old project derived its auth token in
 * two files that had already drifted apart, which is how a CLI and a server come to disagree about who
 * is allowed in.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:20138';
export const DEFAULT_DASHBOARD_URL = 'http://localhost:20137';

/**
 * The browser origin the gateway treats as the local dashboard.
 *
 * Management routes accept two kinds of caller: a public API key, or the dashboard — which the gateway
 * defines as *an allowlisted origin presenting the per-launch token*. The token lives in a `0600` file
 * this user already owns, and a process that can read the vault is not gaining anything by sending it,
 * so the CLI presents both and stays inside the same trust the dashboard has rather than inventing a
 * third one. `OMNIHILBRAS_API_KEY` overrides this for a caller that would rather use a key.
 */
export const DASHBOARD_ORIGIN = process.env.OMNIHILBRAS_ORIGIN?.trim() || DEFAULT_DASHBOARD_URL;

/** The config directory the gateway itself uses, so the CLI reads the same installation. */
export function configDirectory(env = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'omnihilbras');
}

/** The per-launch token the dashboard presents. Absent when no gateway has run yet. */
export function readDashboardToken(env = process.env) {
  try {
    const value = fs.readFileSync(path.join(configDirectory(env), 'dashboard-token'), 'utf8').trim();
    return value || undefined;
  } catch {
    // A missing token is a normal state, not an error: the gateway may not have run yet, and every verb
    // that needs one reports what to do about it at the point it finds out.
    return undefined;
  }
}

/**
 * How this invocation authenticates.
 *
 * An explicit key wins, because a caller who supplied one meant it. Otherwise the local dashboard token.
 * Neither is ever printed, echoed in an error, or written to a log — the value is returned for the
 * request and nothing else.
 */
export function resolveAuth(flags, env = process.env) {
  const apiKey = flags.apiKey?.trim() || env.OMNIHILBRAS_API_KEY?.trim();
  if (apiKey) return { kind: 'api-key', apiKey };
  const dashboardToken = readDashboardToken(env);
  if (dashboardToken) return { kind: 'dashboard', dashboardToken };
  return { kind: 'none' };
}

export function resolveGatewayUrl(flags, env = process.env) {
  const chosen = flags.gateway?.trim() || env.OMNIHILBRAS_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
  // Trailing slashes are dropped so every caller can concatenate a path without thinking about it.
  return chosen.replace(/\/+$/, '');
}
