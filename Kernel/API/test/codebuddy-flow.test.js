import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry, InMemorySecretStore } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * The CodeBuddy sign-in, for both regions, through the gateway.
 *
 * The properties guarded here are the ones a wire-detail change would quietly break:
 *
 * 1. It is **not** a typed device code. The start returns a `verificationUrl` and no `userCode`, and the
 *    dashboard relies on that to render an approval page rather than an empty code box.
 * 2. `code: 11217` is *pending*, not a failure — reading it as a refusal would end every sign-in the
 *    moment it began, because that is the answer until the user approves.
 * 3. The region a session was started against is the region it is polled against. Each card is a
 *    different domain and a different account, so crossing them would exchange a grant at the wrong host.
 */

function scriptTransport(script) {
  const calls = [];
  const transport = {
    calls,
    async request(request) {
      calls.push(request);
      const answer = script(request);
      return { status: answer?.status ?? 200, headers: new Headers(), data: answer?.data ?? {} };
    },
    async *stream() {},
  };
  return transport;
}

async function buildService(script) {
  const transport = scriptTransport(script);
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { transport });
  return { service, transport, key };
}

async function withServer(service, run) {
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function startFlow(base, providerId, key) {
  return fetch(`${base}/v1/oauth/${providerId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: '{}',
  });
}

function poll(base, providerId, sessionId, key) {
  return fetch(`${base}/v1/oauth/${providerId}/session/${sessionId}`, { headers: { authorization: `Bearer ${key}` } });
}

const REGIONS = [
  { providerId: 'codebuddy-cn', host: 'https://copilot.tencent.com', platform: 'CLI' },
  { providerId: 'codebuddy-intl', host: 'https://www.codebuddy.ai', platform: 'ide' },
];

for (const region of REGIONS) {
  test(`CodeBuddy (${region.providerId}): start returns an approval URL and no code`, async () => {
    const { service, transport, key } = await buildService((request) => {
      if (request.url.includes('/v2/plugin/auth/state')) {
        return { data: { code: 0, data: { state: 'STATE-1', authUrl: 'https://example.test/approve?state=STATE-1' } } };
      }
      return { data: {} };
    });

    await withServer(service, async (base) => {
      const response = await startFlow(base, region.providerId, key);
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.match(body.sessionId, /^[A-Za-z0-9_-]{16,128}$/);
      assert.equal(body.verificationUrl, 'https://example.test/approve?state=STATE-1');
      assert.equal(body.userCode, undefined, 'there is no code to type, and saying there is one would render an empty box');

      const stateCall = transport.calls.find((call) => call.url.includes('/v2/plugin/auth/state'));
      assert.ok(stateCall, 'the start must ask the gateway for a state key');
      assert.ok(stateCall.url.startsWith(`${region.host}/v2/plugin/auth/state`), 'the start must reach the region the card names');
      assert.ok(stateCall.url.endsWith(`platform=${region.platform}`), `the start must send platform=${region.platform}`);
    });
  });

  test(`CodeBuddy (${region.providerId}): 11217 is pending, and the region the session started on is the one polled`, async () => {
    let polled = 0;
    const pollUrls = [];
    const { service, key } = await buildService((request) => {
      if (request.url.includes('/v2/plugin/auth/state')) {
        return { data: { code: 0, data: { state: 'STATE-1', authUrl: 'https://example.test/approve' } } };
      }
      if (request.url.includes('/v2/plugin/auth/token')) {
        pollUrls.push(request.url);
        polled += 1;
        if (polled === 1) return { data: { code: 11217, msg: 'RetryFetchToken' } };
        return {
          data: { code: 0, data: { accessToken: 'ACCESS-1', refreshToken: 'REFRESH-1', expiresIn: 86400 } },
        };
      }
      return { data: {} };
    });

    await withServer(service, async (base) => {
      const started = await (await startFlow(base, region.providerId, key)).json();

      const first = await (await poll(base, region.providerId, started.sessionId, key)).json();
      assert.equal(first.status, 'pending', '11217 is still-waiting, not a refusal');

      const second = await (await poll(base, region.providerId, started.sessionId, key)).json();
      assert.equal(second.status, 'connected', JSON.stringify(second));
      assert.equal(pollUrls.length, 2);
      for (const url of pollUrls) {
        assert.ok(url.startsWith(`${region.host}/v2/plugin/auth/token`), `the poll must stay on ${region.host}`);
        assert.ok(url.includes('state=STATE-1'), 'the poll must present the state key, not the session id');
      }
    });
  });
}

test('CodeBuddy: a non-zero code other than 11217 fails the sign-in and says why', async () => {
  const { service, key } = await buildService((request) => {
    if (request.url.includes('/v2/plugin/auth/state')) {
      return { data: { code: 0, data: { state: 'STATE-1', authUrl: 'https://example.test/approve' } } };
    }
    if (request.url.includes('/v2/plugin/auth/token')) {
      return { data: { code: 1001, msg: 'user denied the request' } };
    }
    return { data: {} };
  });

  await withServer(service, async (base) => {
    const started = await (await startFlow(base, 'codebuddy-cn', key)).json();
    const status = await (await poll(base, 'codebuddy-cn', started.sessionId, key)).json();
    assert.equal(status.status, 'failed');
    assert.match(status.error, /user denied the request/);
  });
});

test('CodeBuddy: a start the gateway refuses is reported, not turned into an empty session', async () => {
  const { service, key } = await buildService((request) => {
    if (request.url.includes('/v2/plugin/auth/state')) return { data: { code: 50000, msg: 'service unavailable' } };
    return { data: {} };
  });

  await withServer(service, async (base) => {
    const response = await startFlow(base, 'codebuddy-intl', key);
    assert.ok(response.status >= 400, 'a refused start must not answer 201 with a session nobody can finish');
  });
});
