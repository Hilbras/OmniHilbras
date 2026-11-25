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
/** The historical single-gateway port, whose file keeps its original name. */
const LEGACY_PORT = 20138;

export function dashboardTokenPath(env: Readonly<Record<string, string | undefined>> = process.env, port?: number) {
  const name = port === undefined || port === LEGACY_PORT ? tokenFileName : `${tokenFileName}-${port}`;
  return join(defaultStateDirectory(env), name);
}

/**
 * A fresh token. **Nothing is written here**, and that separation is the point of this function existing.
 *
 * Minting used to write the file on the spot, 27 lines before `listen()` — so a gateway that started while
 * another held the port published its token and *then* died on `EADDRINUSE`. The survivor kept serving with
 * the token it had minted, while the file the dashboard's dev server reads held the dead process's; every
 * management call answered 401 and the shell said "Gateway needs sign-in", with "reload the dashboard" as
 * advice that could not work because the browser never holds the token. Measured: file written four seconds
 * into a start, and its contents refused by the gateway that was actually listening.
 */
export function createDashboardToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Publishes the token where the dashboard's dev server reads it — **after this process is listening**.
 *
 * The file is a claim about which token the running gateway accepts, so it may only be written by a gateway
 * that is in fact running. A caller that has not bound its port has nothing to claim.
 */
export async function publishDashboardToken(token: string, env: Readonly<Record<string, string | undefined>> = process.env, port?: number) {
  await atomicWrite(dashboardTokenPath(env, port), token);
}

/** The token the gateway issued at start, read back from disk, or undefined when it is missing. */
export async function readDashboardToken(env: Readonly<Record<string, string | undefined>> = process.env, port?: number) {
  const value = await readOptionalText(dashboardTokenPath(env, port), maxTokenBytes);
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
