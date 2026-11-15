import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * `POST /v1/system/shutdown` — the dashboard's stop button.
 *
 * It exists for the update notice's manual path: copy the install command, stop the server, run the command
 * in a terminal, start again. The alternative an hour before it was written was a person hunting a terminal
 * to kill a process, which is the step the reference implementation automated.
 *
 * What the assertions are about, in order of what would actually hurt:
 *
 * 1. **It cannot be reached by a local process with no credential** when management enforcement is on. A
 *    route that stops the server is the most disruptive write in the surface, and `/v1/system` is a
 *    management prefix — this file proves the gate covers it rather than assuming the prefix list is right.
 * 2. **A refusal, not a lie.** A gateway with no shutdown hook answers `503` saying it cannot stop itself,
 *    rather than `{"stopping": true}` and continuing to run.
 * 3. **The answer arrives before the stop.** A process that has already gone cannot tell anyone it is going.
 */

async function startGateway(t, { enforced, onShutdownRequest } = {}) {
  const apiKeys = new InMemoryApiKeyStore();
  if (enforced !== undefined) await apiKeys.setEnforced(enforced);
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({ ollama: { type: 'api-key', value: 'x' } }),
    new InMemoryConnectionStore(),
    apiKeys,
  );
  const server = createGatewayServer(service, {
    corsOrigins: ['http://localhost:5173'],
    ...(onShutdownRequest ? { onShutdownRequest } : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a trusted dashboard origin stops the gateway, and the answer comes first', async (t) => {
  let stopped = 0;
  const { base } = await startGateway(t, {
    enforced: true,
    onShutdownRequest: () => {
      stopped += 1;
    },
  });

  // `content-type: application/json` because the gateway refuses a POST without it at the edge (`415`),
  // before any route runs — which is exactly what the browser dashboard was hitting.
  const response = await fetch(`${base}/v1/system/shutdown`, {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
    body: '{}',
  });
  /**
   * "The answer comes first" is proven by the answer existing: the hook runs from the response's `finish`
   * event, so a stop that happened before the reply would have left this fetch with a socket error instead
   * of a body. A timestamp comparison here was the first version of this assertion and it was **wrong** —
   * the server finishes writing before the client's `response.json()` resolves, so it failed on correct
   * code. The observable property is the one above.
   */
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopping: true }, 'it says what it is doing');

  for (let waited = 0; waited < 40 && stopped === 0; waited += 1) await wait(25);
  assert.equal(stopped, 1, 'and the hook ran exactly once');
});

test('a gateway with no shutdown hook refuses instead of claiming a stop', async (t) => {
  const { base } = await startGateway(t, { enforced: true });

  const response = await fetch(`${base}/v1/system/shutdown`, {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'SHUTDOWN_UNAVAILABLE', 'the refusal is named');
  assert.match(body.error.message, /cannot stop itself/, 'and says why, in words a person can act on');
});

test('a local process with no credential cannot stop the gateway', async (t) => {
  let stopped = 0;
  const { base } = await startGateway(t, { enforced: true, onShutdownRequest: () => { stopped += 1; } });

  // No Origin, no Authorization: what any process on this machine can send.
  // No Origin, no Authorization, and a valid JSON content-type: what any process on this machine can send,
  // so the refusal is about the credential rather than about the media type.
  const response = await fetch(`${base}/v1/system/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.ok(response.status === 401 || response.status === 403, `refused, not stopped (got ${response.status})`);

  await wait(60);
  assert.equal(stopped, 0, 'and the hook was never called');
});

test('only POST stops anything', async (t) => {
  let stopped = 0;
  const { base } = await startGateway(t, { enforced: true, onShutdownRequest: () => { stopped += 1; } });

  const response = await fetch(`${base}/v1/system/shutdown`, {
    method: 'GET',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(response.status, 405);
  assert.equal(stopped, 0, 'a GET is not a stop');
});
