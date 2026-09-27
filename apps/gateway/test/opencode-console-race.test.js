import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryConnectionStore } from '../dist/index.js';

/**
 * A device code is single-use. The poll that receives the token kills it, so a second
 * poll of the same code is told the code is invalid.
 *
 * The dashboard polls every second and saving a connection is slower than that, so two
 * polls overlap. Before the exchange was claimed, the losing poll spent the dead code
 * and overwrote a success that had already happened — which presented as
 * "Sign-in did not finish — The device code is invalid" immediately after the Console
 * said "Device authorized".
 *
 * These tests drive the real service method with a stubbed Console, so the race is
 * reproduced rather than described.
 */

const SERVER = 'https://console.opencode.ai';
const START = `${SERVER}/auth/device/code`;
const TOKEN = `${SERVER}/auth/device/token`;

function createService() {
  return new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore());
}

/**
 * A Console that reports the device authorized on the `approveAfter`-th token poll and
 * treats the code as dead afterwards, exactly as a single-use grant behaves.
 */
function consoleStub({ state, approveAfter = 1, tokenDelayMs = 0 }) {
  state.tokenPolls = 0;
  state.tokenCalls = 0;
  state.used = false;
  return async (url, init) => {
    if (url === START) {
      return new Response(
        JSON.stringify({
          device_code: 'dev_fixed',
          user_code: 'ABCD-1234',
          verification_uri: '/console/device',
          verification_uri_complete: '/console/device?user_code=ABCD-1234&client_id=opencode-cli',
          expires_in: 600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === TOKEN) {
      state.tokenCalls += 1;
      state.tokenPolls += 1;
      if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs));
      if (state.used) {
        // What the Console says once the grant has been spent.
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'The device code is invalid' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (state.tokenPolls < approveAfter) {
        return new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      state.used = true;
      return new Response(JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === `${SERVER}/api/user`) return new Response(JSON.stringify({ id: 'usr', email: 'dev@example.com' }), { status: 200 });
    if (url === `${SERVER}/api/orgs`) return new Response(JSON.stringify([{ id: 'org_x', name: 'Personal' }]), { status: 200 });
    if (url === `${SERVER}/api/config`) {
      return new Response(
        JSON.stringify({ config: { provider: { opencode: { options: { headers: { 'x-opencode-org-id': 'wrk_x' } } } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 404 });
  };
}

async function withConsole(t, options, run) {
  const realFetch = globalThis.fetch;
  const state = {};
  globalThis.fetch = consoleStub({ state, ...options });
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return run(state);
}

test('two overlapping polls do not spend the same device code twice', async (t) => {
  await withConsole(t, { tokenDelayMs: 40 }, async (state) => {
    const service = createService();
    const started = await service.startOpencodeConsoleSignIn();

    // The dashboard polls on a timer, so two requests overlap while the first saves.
    const [first, second] = await Promise.all([
      service.opencodeConsoleSignInStatus(started.sessionId),
      service.opencodeConsoleSignInStatus(started.sessionId),
    ]);

    const statuses = [first, second].filter(Boolean);
    assert.equal(statuses.length, 2, 'both polls answer');
    assert.equal(
      statuses.filter((status) => status.status === 'connected').length,
      1,
      'exactly one poll reports connected',
    );
    assert.equal(
      statuses.filter((status) => status.status === 'failed').length,
      0,
      `no poll may report a failure over a success: ${JSON.stringify(statuses.map((s) => [s.status, s.error]))}`,
    );
    assert.equal(state.tokenCalls, 1, 'the Console is asked for the token exactly once');
  });
});

test('a poll arriving after the exchange is already done does not call the Console', async (t) => {
  await withConsole(t, {}, async (state) => {
    const service = createService();
    const started = await service.startOpencodeConsoleSignIn();
    const first = await service.opencodeConsoleSignInStatus(started.sessionId);
    assert.equal(first.status, 'connected');
    assert.equal(state.tokenCalls, 1);

    // A late poll, as a browser tab left open would send.
    const late = await service.opencodeConsoleSignInStatus(started.sessionId);
    assert.equal(late.status, 'connected', 'a finished sign-in stays connected');
    assert.equal(state.tokenCalls, 1, 'and the spent code is not offered again');
  });
});

test('a still-pending sign-in is polled again on the next request', async (t) => {
  await withConsole(t, { approveAfter: 3 }, async (state) => {
    const service = createService();
    const started = await service.startOpencodeConsoleSignIn();

    const first = await service.opencodeConsoleSignInStatus(started.sessionId);
    assert.equal(first.status, 'pending', 'nothing was approved yet');
    const second = await service.opencodeConsoleSignInStatus(started.sessionId);
    assert.equal(second.status, 'pending');
    assert.equal(state.tokenCalls, 2, 'a pending claim is released, so the next poll may try');
    assert.equal(state.used, false, 'a pending poll never consumes the code');
  });
});

test('a refused approval is reported once and stays refused', async (t) => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (url === START) {
      return new Response(JSON.stringify({ device_code: 'd', user_code: 'A', verification_uri: '/console/device' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === TOKEN) {
      calls += 1;
      return new Response(JSON.stringify({ error: 'access_denied', error_description: 'The request was declined.' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const service = createService();
  const started = await service.startOpencodeConsoleSignIn();
  const failed = await service.opencodeConsoleSignInStatus(started.sessionId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'The request was declined.');

  const again = await service.opencodeConsoleSignInStatus(started.sessionId);
  assert.equal(again.status, 'failed', 'a refusal is terminal and is not re-attempted');
  assert.equal(calls, 1, 'the Console is not polled again after a refusal');
});
