import assert from 'node:assert/strict';
import test from 'node:test';
import { deepSeekHashV1 } from '../deepseek-web/dist/lib/deepseek-pow.js';
import {
  DeepSeekWebAdapter,
  deepseekWebProviderId,
  deepseekWebV2ProviderId,
} from '../deepseek-web/dist/adapter/index.js';

/**
 * The second DeepSeek Web variant.
 *
 * `deepseek-web` is live, so its request shape is a regression guard here: the same headers v1 has
 * always sent, and no `x-device-id`. Everything v2 adds comes from
 * `docs/reports/deepseek-web-capture.md` — the 2.8.0 build's headers, the `action` field on the
 * completion body, and the server-delivered model catalogue.
 */

const SALT = 'salt-for-tests';
const EXPIRE_AT = 1790579999;

const DONE_STREAM = [
  'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"RESPONSE","content":"pong"}]}}}',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  'data: [DONE]',
  '',
].join('\n');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function header(headers, name) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

/** Records every request and answers the four endpoints a turn needs. */
function recordingFetch(requests, overrides = {}) {
  return async (url, init) => {
    const path = String(url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url: path, headers: init?.headers ?? {}, body });
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) return handler(requests.at(-1));
    }
    if (path.includes('users/current')) return jsonResponse({ code: 0, data: { biz_data: { token: 'access' } } });
    if (path.includes('create_pow_challenge')) {
      return jsonResponse({
        code: 0,
        data: {
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: deepSeekHashV1(`${SALT}_${EXPIRE_AT}_3`),
              salt: SALT,
              difficulty: 8,
              signature: 'sig',
              target_path: '/api/v0/chat/completion',
              expire_at: EXPIRE_AT,
            },
          },
        },
      });
    }
    if (path.includes('chat_session/create')) return jsonResponse({ code: 0, data: { biz_data: { chat_session: { id: 'session-1' } } } });
    return new Response(DONE_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const CREDENTIAL = { type: 'api-key', value: 'user-token' };

function completionRequests(requests) {
  return requests.filter((request) => request.url.includes('/chat/completion'));
}

test('the second variant has its own provider id and name', () => {
  const v1 = new DeepSeekWebAdapter();
  const v2 = new DeepSeekWebAdapter({ variant: 'v2' });
  assert.equal(v1.id, deepseekWebProviderId);
  assert.equal(v1.id, 'deepseek-web');
  assert.equal(v1.name, 'DeepSeek Web');
  assert.equal(v2.id, deepseekWebV2ProviderId);
  assert.equal(v2.id, 'deepseek-web-v2');
  assert.equal(v2.name, 'DeepSeek Web V2');
});

test('v1 still sends the 2.0.0 fingerprint and no device id', async () => {
  // v1 is live today. Its bytes are the contract, so this is a regression guard, not a snapshot.
  const requests = [];
  const adapter = new DeepSeekWebAdapter({ variant: 'v1', fetch: recordingFetch(requests) });
  await adapter.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }] }, { credential: CREDENTIAL });

  const completion = completionRequests(requests).at(-1);
  assert.ok(completion, 'no completion was sent');
  assert.equal(header(completion.headers, 'x-client-version'), '2.0.0');
  assert.equal(header(completion.headers, 'x-client-locale'), 'en-US');
  assert.equal(header(completion.headers, 'x-device-id'), undefined);
  assert.equal(header(completion.headers, 'x-device-model'), undefined);
  assert.ok(!('action' in completion.body), `v1 must not send action: ${JSON.stringify(completion.body)}`);

  // The default variant is v1, and every call carries the same stamp.
  for (const request of requests.filter((entry) => entry.headers && Object.keys(entry.headers).length > 0)) {
    assert.equal(header(request.headers, 'x-client-version'), '2.0.0', `${request.url} sent the wrong client version`);
  }
});

test('v2 sends the 2.8.0 fingerprint, one stable device id, and action: null', async () => {
  const requests = [];
  const adapter = new DeepSeekWebAdapter({ variant: 'v2', fetch: recordingFetch(requests) });
  await adapter.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }] }, { credential: CREDENTIAL });
  await adapter.chat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping again' }] }, { credential: CREDENTIAL });

  const completions = completionRequests(requests);
  assert.equal(completions.length, 2);

  const deviceIds = new Set();
  for (const completion of completions) {
    assert.equal(header(completion.headers, 'x-client-version'), '2.8.0');
    assert.equal(header(completion.headers, 'x-client-locale'), 'en_US');
    assert.equal(header(completion.headers, 'x-client-bundle-id'), 'com.deepseek.chat');
    assert.equal(header(completion.headers, 'x-client-platform'), 'web');
    assert.equal(header(completion.headers, 'x-device-model'), '');
    assert.match(header(completion.headers, 'x-device-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(completion.body.action, null, 'the live client sends action: null');
    deviceIds.add(header(completion.headers, 'x-device-id'));
  }
  assert.equal(deviceIds.size, 1, `the device id changed between calls: ${[...deviceIds].join(', ')}`);

  // The device id is per request path, not only on the completion — the capture shows it on every
  // `/api/v0/*` call.
  for (const request of requests.filter((entry) => entry.headers && Object.keys(entry.headers).length > 0)) {
    assert.equal(header(request.headers, 'x-device-id'), [...deviceIds][0], `${request.url} sent no device id`);
  }
});

const SETTINGS_BODY = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      version: 102,
      settings: {
        model_configs: {
          id: 1356454870,
          value: [
            { model_type: 'default', name: 'Instant', is_default: true, enabled: true },
            { model_type: 'expert', name: 'Expert', is_default: false, enabled: true },
            { model_type: 'vision', name: 'Vision', is_default: false, enabled: true },
          ],
        },
      },
    },
  },
};

test('v2 reads the model catalogue from client/settings', async () => {
  const requests = [];
  const adapter = new DeepSeekWebAdapter({
    variant: 'v2',
    fetch: recordingFetch(requests, {
      'https://chat.deepseek.com/api/v0/client/settings': () => jsonResponse(SETTINGS_BODY),
    }),
  });
  const models = await adapter.listModels({ credential: CREDENTIAL });

  // Still the full, usable catalogue — the server names the models, it does not replace the table.
  assert.equal(models.length, 14);
  for (const model of models) assert.equal(model.providerId, 'deepseek-web-v2');

  // The captured settings call, with the same device id the request path sends.
  const settingsCall = requests.find((request) => request.url.includes('/client/settings'));
  assert.ok(settingsCall, 'client/settings was never asked');
  assert.match(settingsCall.url, /scope=model/);
  const deviceId = header(settingsCall.headers, 'x-device-id');
  assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.ok(settingsCall.url.includes(`did=${encodeURIComponent(deviceId)}`), 'the settings call must carry the same device id');

  const byId = new Map(models.map((model) => [model.id, model]));
  assert.equal(byId.get('deepseek-v4-flash').displayName, 'Instant');
  assert.equal(byId.get('deepseek-v4-pro').displayName, 'Expert');
  // Ids the settings do not mention are kept, with the built-in names.
  assert.equal(byId.get('deepseek-v4-pro-think').displayName, 'DeepSeek V4 Pro Think');
  assert.ok(byId.has('deepseek-chat'));
});

test('v2 falls back to the built-in table when client/settings misbehaves', async () => {
  const cases = [
    ['a non-200 answer', () => jsonResponse({ error: 'nope' }, 500)],
    ['a network error', () => { throw new Error('ECONNRESET'); }],
    ['a body that is not JSON', () => new Response('<html>gateway</html>', { status: 200 })],
    ['settings with no model list', () => jsonResponse({ code: 0, data: { biz_data: { settings: {} } } })],
    ['an unexpected value shape', () => jsonResponse({ code: 0, data: { biz_data: { settings: { model_configs: { id: 1, value: 'nope' } } } } })],
    ['descriptors with no model_type', () => jsonResponse({ code: 0, data: { biz_data: { settings: { model_configs: { value: [{ name: 'Instant' }] } } } } })],
  ];
  for (const [what, settingsResponse] of cases) {
    const requests = [];
    const adapter = new DeepSeekWebAdapter({
      variant: 'v2',
      fetch: recordingFetch(requests, {
        'https://chat.deepseek.com/api/v0/client/settings': settingsResponse,
      }),
    });
    const models = await adapter.listModels({ credential: CREDENTIAL });
    assert.equal(models.length, 14, `${what} produced ${models.length} models`);
    const byId = new Map(models.map((model) => [model.id, model]));
    assert.equal(byId.get('deepseek-v4-flash').displayName, 'DeepSeek V4 Flash', `${what} did not fall back`);
    assert.equal(byId.get('deepseek-v4-pro').displayName, 'DeepSeek V4 Pro', `${what} did not fall back`);
  }
});

test('v2 with no credential never asks the network, and still lists the table', async () => {
  const requests = [];
  const adapter = new DeepSeekWebAdapter({ variant: 'v2', fetch: recordingFetch(requests) });
  const models = await adapter.listModels();
  assert.equal(models.length, 14);
  assert.equal(requests.length, 0, 'a model list must not fail, or send anything, without a credential');
});