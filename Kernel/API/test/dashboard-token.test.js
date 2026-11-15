import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardToken, dashboardTokenPath, publishDashboardToken, readDashboardToken, tokenMatches } from '../dist/src/core/dashboard-token.js';

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

test('the token is published into a private file and read back', async (t) => {
  const env = await sandbox(t);
  const issued = createDashboardToken();
  await publishDashboardToken(issued, env);
  assert.match(issued, /^[0-9a-f]{64}$/, '32 random bytes, hex encoded');

  const path = dashboardTokenPath(env);
  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600, 'the token file is owner-only');
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700, 'and so is its directory');

  assert.equal(await readDashboardToken(env), issued, 'the gateway reads back what it issued');
});

test('a new launch means a new token, so a leaked one stops working', async (t) => {
  const env = await sandbox(t);
  const first = createDashboardToken();
  const second = createDashboardToken();
  await publishDashboardToken(second, env);
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
  // `startGatewayServer` mints one unconditionally; the `dashboardToken === undefined` branch in
  // `createGatewayServer` exists for embedders and for tests that build the server directly. This asserts
  // the shipped entry point keeps minting, because that branch is the weaker rule.
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8'));
  assert.match(source, /const dashboardToken = createDashboardToken\(\)/, 'startGatewayServer must mint a dashboard token');
  assert.match(source, /createGatewayServer\(service, \{[\s\S]{0,2000}?dashboardToken,/, 'and pass it to the server it builds');
});

test('the token is published only after the port is bound', async () => {
  /**
   * The ordering is the whole fix, so it is asserted rather than assumed.
   *
   * The file is a claim about which token the *running* gateway accepts. It used to be written 27 lines
   * before `listen()` — so a gateway that lost the port race published its token, died on `EADDRINUSE`, and
   * left the survivor serving with a token nobody could present: every dashboard call answered 401 and the
   * shell said "Gateway needs sign-in", with "reload the dashboard" as advice that could not work because the
   * browser never holds the token. Measured: the file was written four seconds into a start, and its contents
   * were refused by the gateway that was actually listening.
   */
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8'));
  const mint = source.indexOf('const dashboardToken = createDashboardToken()');
  const listening = source.indexOf("server.once('listening', onListening)");
  const publish = source.indexOf('await publishDashboardToken(dashboardToken, options.env)');
  assert.ok(mint >= 0 && listening >= 0 && publish >= 0, 'all three steps are present');
  assert.ok(mint < listening, 'the token is minted before the server starts listening');
  assert.ok(listening < publish, 'and published only after it is listening');
});

test('minting writes nothing, so a process that never binds claims nothing', async (t) => {
  const env = await sandbox(t);
  const token = createDashboardToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  await assert.rejects(() => stat(dashboardTokenPath(env)), 'no file exists until it is published');
});
