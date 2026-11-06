import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, defaultStateDirectory, readOptionalText } from './secure-store.js';

/**
 * A secret the gateway makes at start and shares only with the dashboard's dev server.
 *
 * Origin is set by any local process, so it cannot tell the dashboard from a script. This token can:
 * the dashboard's Vite server reads it from a user-only file and adds it to the requests it proxies,
 * so the browser never holds it. A page on another origin cannot read the file, and cannot make the
 * proxy add the header to its own requests.
 *
 * It is regenerated at every start, so a leaked value stops working when the gateway restarts.
 */

export const dashboardTokenHeader = 'x-omnihilbras-dashboard-token';
const tokenFileName = 'dashboard-token';
const maxTokenBytes = 256;

export function dashboardTokenPath(env: Readonly<Record<string, string | undefined>> = process.env) {
  return join(defaultStateDirectory(env), tokenFileName);
}

/** Creates a fresh token, writes it at 0600 in the 0700 state directory, and returns it. */
export async function issueDashboardToken(env: Readonly<Record<string, string | undefined>> = process.env) {
  const token = randomBytes(32).toString('hex');
  await atomicWrite(dashboardTokenPath(env), token);
  return token;
}

/** The token the gateway issued at start, read back from disk, or undefined when it is missing. */
export async function readDashboardToken(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = await readOptionalText(dashboardTokenPath(env), maxTokenBytes);
  return value?.trim() || undefined;
}

/** Constant-time comparison, so the check does not reveal how much of the token matched. */
export function tokenMatches(presented: string | undefined, expected: string | undefined) {
  if (!presented || !expected) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
