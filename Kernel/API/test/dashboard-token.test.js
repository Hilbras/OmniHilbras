import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardTokenPath, issueDashboardToken, readDashboardToken, tokenMatches } from '../dist/src/core/dashboard-token.js';

/**
 * The per-launch dashboard token.
 *
 * This is what makes `kind: 'dashboard'` mean anything: `Origin` is a header any local process writes, so
 * the token — not the origin — is the credential. The security audit's first version of finding F5 said
 * the trust came from the Origin header alone and that any local process could claim it; that was wrong,
 * and this file is the evidence it was wrong.
 *
 * The residual is real and is what the last test states: a process running as the operator can read the
 * token file — but the same access reads the credential vault, so the OS user is the boundary.
 */

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { OMNIHILBRAS_DATA_DIR: dir, XDG_CONFIG_HOME: join(dir, 'config') };
}

test('the token is issued into a private file and read back', async (t) => {
  const env = await sandbox(t);
  const issued = await issueDashboardToken(env);
  assert.match(issued, /^[0-9a-f]{64}$/, '32 random bytes, hex encoded');

  const path = dashboardTokenPath(env);
  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600, 'the token file is owner-only');
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700, 'and so is its directory');

  assert.equal(await readDashboardToken(env), issued, 'the gateway reads back what it issued');
});

test('a new launch means a new token, so a leaked one stops working', async (t) => {
  const env = await sandbox(t);
  const first = await issueDashboardToken(env);
  const second = await issueDashboardToken(env);
  assert.notEqual(first, second);
  assert.equal(await readDashboardToken(env), second);
});

test('the comparison is exact', () => {
  const token = 'a'.repeat(64);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, 'b'.repeat(64)), false);
  assert.equal(tokenMatches('a'.repeat(63), token), false);
  assert.equal(tokenMatches(undefined, token), false);
  assert.equal(tokenMatches(token, undefined), false);
  assert.equal(tokenMatches('', token), false);
});

test('a server started without a token cannot be the shipped path', async () => {
  // `startGatewayServer` issues one unconditionally; the `dashboardToken === undefined` branch in
  // `createGatewayServer` exists for embedders and for tests that build the server directly. This asserts
  // the shipped entry point keeps issuing, because that branch is the weaker rule.
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8'));
  assert.match(source, /const dashboardToken = await issueDashboardToken\(options\.env\)/, 'startGatewayServer must issue a dashboard token');
  assert.match(source, /createGatewayServer\(service, \{[\s\S]{0,2000}?dashboardToken,/, 'and pass it to the server it builds');
});
