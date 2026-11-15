import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishDashboardToken, readDashboardToken } from '../dist/src/core/dashboard-token.js';
import { loadGatewayConfig, startGatewayServer } from '../dist/src/index.js';

/**
 * The dashboard token may only be published by a gateway that is actually listening.
 *
 * The token file is what the dashboard's dev server attaches to every management call, so it is a claim about
 * which token the *running* gateway accepts. Writing it before a successful bind means a process that loses the
 * port race publishes its token and then dies on `EADDRINUSE`, leaving the survivor serving with a token nobody
 * can present: every dashboard call answers 401 and the shell says "Gateway needs sign-in", while "reload the
 * dashboard" cannot help, because the browser never holds the token — it is the dev server that reads this file.
 *
 * That is not hypothetical. Measured on this machine: a token file written four seconds into a start (the mint
 * sat 27 lines before `listen()`), whose contents the gateway that was actually listening refused.
 */

test('a gateway that loses the port race leaves the running one’s token alone', async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), 'dashboard-token-race-'));
  t.after(() => rm(stateHome, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: stateHome };

  // The incumbent: a gateway already listening, which published its token when it bound.
  const incumbent = 'a'.repeat(64);
  await publishDashboardToken(incumbent, env);

  // A second process that finds the port taken.
  const held = createServer();
  await new Promise((resolve) => held.listen(0, '127.0.0.1', resolve));
  const port = held.address().port;
  t.after(() => new Promise((resolve) => held.close(resolve)));

  const config = loadGatewayConfig({ OMNIHILBRAS_HOST: '127.0.0.1' });
  await assert.rejects(
    () => startGatewayServer({ config: { ...config, port }, env }),
    (error) => /EADDRINUSE|address already in use/i.test(String(error?.message ?? error)),
    'the second process cannot bind, and says so',
  );

  assert.equal(
    await readDashboardToken(env),
    incumbent,
    'so the file still holds the token the running gateway accepts — the 401 this test exists for',
  );
});
