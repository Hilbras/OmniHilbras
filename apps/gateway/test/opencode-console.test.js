import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENCODE_CONSOLE, beginOpencodeConsoleSignIn, pollOpencodeConsoleSignIn, OpencodeConsoleSessionStore } from '../dist/opencodeConsole.js';

/**
 * The Console serves its API from `console.opencode.ai` and its web pages from
 * `opencode.ai`. Its `verification_uri` is relative, so joining it to the API host
 * produces `/console/console/device`, which renders a blank page. That bug shipped
 * once and looked like the sign-in simply doing nothing, so it is pinned here.
 */

const realFetch = globalThis.fetch;

/** Answers the device-code call the way the Console does. */
function withDeviceCode(body, handler) {
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceCodePath}`) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return handler(target, init);
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the verification URL is built on the web host, not the API host', async () => {
  withDeviceCode(
    {
      device_code: 'dev_1',
      user_code: 'ABCD-1234',
      verification_uri: '/console/device',
      verification_uri_complete: '/console/device?user_code=ABCD-1234&client_id=opencode-cli',
      expires_in: 600,
      interval: 5,
    },
    async () => new Response('{}', { status: 404 }),
  );
  const started = await beginOpencodeConsoleSignIn();
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(
    started.verificationUrl,
    'https://opencode.ai/console/device?user_code=ABCD-1234&client_id=opencode-cli',
  );
  assert.ok(
    !started.verificationUrl.startsWith(OPENCODE_CONSOLE.server),
    `must not hang off the API host, or the path doubles to /console/console/device`,
  );
  assert.ok(!started.verificationUrl.includes('/console/console/'), 'the path must not double');
});

test('a relative URI without a leading slash is still joined cleanly', async () => {
  withDeviceCode({ device_code: 'd', user_code: 'X', verification_uri: 'console/device' }, async () => new Response('{}', { status: 404 }));
  const started = await beginOpencodeConsoleSignIn();
  assert.equal(started.verificationUrl, 'https://opencode.ai/console/device');
});

test('a device code response with no code is an error, not a broken link', async () => {
  withDeviceCode({}, async () => new Response('{}', { status: 404 }));
  await assert.rejects(() => beginOpencodeConsoleSignIn(), /did not return a device code/);
});

test('a pending poll is pending even though the Console answers 400', async () => {
  withDeviceCode({}, async (url) => {
    if (url === `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`) {
      return new Response(JSON.stringify({ _tag: 'Unauthorized', error: 'authorization_pending' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  });
  assert.deepEqual(await pollOpencodeConsoleSignIn('dev_1'), { status: 'pending' });
});

test('slow_down is still pending rather than a failure', async () => {
  withDeviceCode({}, async (url) => {
    if (url === `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`) return new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 });
    return new Response('{}', { status: 404 });
  });
  assert.deepEqual(await pollOpencodeConsoleSignIn('dev_1'), { status: 'pending' });
});

test('a refusal is reported in the Console words when it gives any', async () => {
  withDeviceCode({}, async (url) => {
    if (url === `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`) {
      return new Response(JSON.stringify({ error: 'access_denied', error_description: 'The request was declined.' }), { status: 400 });
    }
    return new Response('{}', { status: 404 });
  });
  const outcome = await pollOpencodeConsoleSignIn('dev_1');
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.error, 'The request was declined.');
});

test('an approval yields a credential carrying the org the client would pick', async () => {
  withDeviceCode({}, async (url) => {
    if (url === `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`) {
      return new Response(
        JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/api/user')) return new Response(JSON.stringify({ id: 'usr_1', email: 'dev@example.com' }), { status: 200 });
    if (url.endsWith('/api/orgs')) {
      // Unsorted on purpose: the client picks the alphabetically first org, so this
      // gateway has to agree with it or the org header will not match.
      return new Response(JSON.stringify([{ id: 'org_zzz', name: 'Zulu' }, { id: 'org_aaa', name: 'Personal' }]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  const outcome = await pollOpencodeConsoleSignIn('dev_1');
  assert.equal(outcome.status, 'connected');
  assert.equal(outcome.credential.type, 'oauth');
  assert.equal(outcome.credential.orgId, 'org_aaa');
  assert.equal(outcome.credential.orgName, 'Personal');
  assert.equal(outcome.credential.email, 'dev@example.com');
  assert.equal(outcome.credential.refreshToken, 'ref');
  assert.ok(Date.parse(outcome.credential.expiresAt) > Date.now(), 'expiry is in the future');
});

test('a token with no account lookup still connects, minus the org', async () => {
  withDeviceCode({}, async (url) => {
    if (url === `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`) {
      return new Response(JSON.stringify({ access_token: 'acc' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 500 });
  });
  const outcome = await pollOpencodeConsoleSignIn('dev_1');
  assert.equal(outcome.status, 'connected');
  assert.equal(outcome.credential.orgId, undefined);
  assert.equal(outcome.credential.expiresAt, undefined);
});

test('a token response with no access token is a refusal, not a silent success', async () => {
  withDeviceCode({}, async (url) => {
    if (url === `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`) return new Response(JSON.stringify({}), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const outcome = await pollOpencodeConsoleSignIn('dev_1');
  assert.equal(outcome.status, 'denied');
});

test('a session is claimed once, so two polls cannot spend the same grant', () => {
  const store = new OpencodeConsoleSessionStore();
  const session = store.create({ deviceCode: 'd', userCode: 'ABCD-1234', verificationUrl: 'https://opencode.ai/console/device' });
  assert.ok(store.claim(session.id));
  assert.equal(store.claim(session.id), undefined, 'the second claim is refused');
  store.release(session);
  assert.ok(store.claim(session.id), 'a failed exchange can be retried');
});

test('an expired session says so instead of polling a dead device code', () => {
  const store = new OpencodeConsoleSessionStore({ ttlMs: 1 });
  const session = store.create({ deviceCode: 'd', userCode: 'ABCD-1234', verificationUrl: 'u' });
  const status = store.get(session.id);
  assert.ok(status);
  // Force the clock past the deadline rather than sleeping.
  session.expiresAt = Date.now() - 1;
  assert.equal(store.get(session.id).status, 'expired');
  assert.match(store.get(session.id).error, /expired/);
});

test('a malformed session id is not found rather than looked up', () => {
  const store = new OpencodeConsoleSessionStore();
  assert.equal(store.get('short'), undefined);
  assert.equal(store.get('../../etc/passwd'), undefined);
  assert.equal(store.claim('short'), undefined);
});
