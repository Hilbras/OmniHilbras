import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { isPublicLlmRoute } from '../dist/src/routes/inference.js';
import { handleVideoRoute } from '../dist/src/routes/video.js';
import { XaiAdapter } from '../../SDK/xai/dist/adapter/index.js';
import { scriptedTransport } from '../../SDK/tests/harness/scripted-transport.js';

/**
 * `/v1/videos/*`, driven by a scripted transport — no key was used and nothing was billed.
 *
 * xAI really creates and polls a job: the create answers with the upstream `request_id` alone, and a
 * poll forwards the upstream status, disclosing `video.url` only when the upstream says it completed.
 * Every other adapter, including one that declares video without a handler, is refused by name. The
 * connection-bound poll, usage ledger, key gate and cancellation are asserted on the same surface.
 */

function videoAdapter(id, capabilities = {}, calls = []) {
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: true, models: true, ...capabilities },
    async listModels() { return [{ id: 'm', providerId: id }]; },
    async *streamChat() { calls.push('stream'); throw new Error('the video route used the chat stream'); },
    async chat() { calls.push('chat'); throw new Error('the video route used the chat adapter'); },
  };
}

async function harness(specs, { video = [] } = {}) {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['m'], video });
  const registry = new ProviderRegistry();
  const calls = [];
  const store = new InMemoryConnectionStore();
  const secrets = {};
  for (const [id, capabilities] of Object.entries(specs)) {
    const adapter = id === 'xai' ? new XaiAdapter({ transport }) : videoAdapter(id, capabilities, calls);
    registry.register(adapter);
    secrets[id] = { type: 'api-key', value: 'secret' };
    await store.save(
      {
        id, providerId: id, name: id,
        // A saved endpoint wins over a package default by design. Use xAI's own host for its
        // connection so the assertion is about the adapter's video path, not an override.
        endpoint: id === 'xai' ? 'https://api.x.ai/v1' : 'https://api.example.test/v1',
        priority: 1, proxyPool: 'none', modelIds: ['m'],
      },
      secrets[id],
    );
  }
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const recorded = [];
  const usageStore = {
    record: async (entry) => { recorded.push(entry); return entry; },
    list: async () => recorded,
  };
  const service = new GatewayService(registry, new InMemorySecretStore(secrets), store, apiKeys, { usageStore, transport });
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, key, calls, recorded, service, server, store, transport };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('every video path is on the authenticated, rate-limited LLM surface', () => {
  for (const path of ['/v1/videos/generations', '/v1/videos/edits', '/v1/videos/extensions']) {
    assert.equal(isPublicLlmRoute('POST', path), true, `${path} is not a public LLM route`);
  }
  assert.equal(isPublicLlmRoute('GET', '/v1/videos/job-1'), true);
  assert.equal(isPublicLlmRoute('GET', '/v1/videos/'), false, 'an empty id is not a poll');
  assert.equal(isPublicLlmRoute('POST', '/v1/videos/anything'), false, 'an unknown action is not a job route');
});

test('a non-video provider refuses by name, records one planned attempt and invents no URL', async () => {
  const { base, key, calls, recorded, server } = await harness({ openai: {} });
  try {
    const response = await fetch(`${base}/v1/videos/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-omnihilbras-connection': 'openai' },
      body: JSON.stringify({ model: 'openai/gpt-video', prompt: 'a short film' }),
    });
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_SUPPORTED');
    assert.match(body.error.message, /Provider "openai" does not declare video generation/);
    assert.doesNotMatch(JSON.stringify(body), /https?:\/\//, 'a fake job URL leaked into the refusal');
    assert.equal(calls.length, 0, 'a provider chat call was made for a video job');
    assert.equal(recorded.length, 1, 'the billable job was not recorded');
    assert.equal(recorded[0].errorCode, 'NOT_SUPPORTED');
    assert.equal(recorded[0].attempts, 1);
    assert.equal(recorded[0].providerId, 'openai');
    assert.equal(recorded[0].connectionId, 'openai');
  } finally {
    await close(server);
  }
});

test('xAI create returns only the upstream request_id and echoes the bound connection', async () => {
  const { base, key, recorded, server, transport } = await harness({ xai: {} }, { video: [{ request_id: 'req-scripted-1' }] });
  try {
    const response = await fetch(`${base}/v1/videos/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-omnihilbras-connection': 'xai' },
      body: JSON.stringify({ model: 'xai/grok-imagine-video', prompt: 'a short film' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.id, 'req-scripted-1', 'the upstream request_id was not the job id');
    assert.equal(body.connectionId, 'xai');
    assert.equal(body.video, undefined, 'create fabricated a video URL');
    assert.equal(response.headers.get('x-omnihilbras-connection'), 'xai');
    assert.doesNotMatch(JSON.stringify(body), /https?:\/\//, 'a fake URL leaked into the create answer');

    assert.equal(transport.videoSeen.length, 1);
    const wire = transport.videoSeen[0];
    assert.equal(wire.method, 'POST');
    assert.equal(new URL(wire.url).hostname, 'api.x.ai');
    assert.match(wire.url, /\/v1\/videos\/generations$/);
    assert.equal(wire.headers.Authorization, 'Bearer secret', 'the pinned connection credential was not sent');
    assert.equal(JSON.parse(wire.body).model, 'grok-imagine-video', 'only the adapter’s own prefix should be stripped');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].outcome, 'success');
    assert.equal(recorded[0].attempts, 1);
  } finally {
    await close(server);
  }
});

test('xAI poll forwards pending, then the upstream URL only after completion', async () => {
  const { base, key, server, transport } = await harness({ xai: {} }, {
    video: [
      { request_id: 'req-scripted-2' },
      { status: 'in_progress' },
      { status: 'completed', video: { url: 'https://cdn.example.test/job.mp4' } },
    ],
  });
  try {
    const headers = { authorization: `Bearer ${key}`, 'x-omnihilbras-connection': 'xai' };
    const created = await (await fetch(`${base}/v1/videos/generations`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xai/grok-imagine-video', prompt: 'a short film' }),
    })).json();
    assert.equal(created.id, 'req-scripted-2');

    const pending = await (await fetch(`${base}/v1/videos/req-scripted-2`, { headers })).json();
    assert.equal(pending.id, 'req-scripted-2');
    assert.equal(pending.status, 'in_progress');
    assert.equal(pending.video, undefined, 'a pending job was given a URL');

    const done = await (await fetch(`${base}/v1/videos/req-scripted-2`, { headers })).json();
    assert.equal(done.status, 'completed');
    assert.equal(done.video.url, 'https://cdn.example.test/job.mp4', 'the upstream URL was not forwarded');

    assert.equal(transport.videoSeen.length, 3);
    const polls = transport.videoSeen.slice(1);
    for (const poll of polls) {
      assert.equal(poll.method, 'GET');
      assert.match(poll.url, /\/v1\/videos\/req-scripted-2$/);
      assert.equal(poll.headers.Authorization, 'Bearer secret');
    }
  } finally {
    await close(server);
  }
});

test('a scripted adapter declaring video without a handler is refused, not given a fake job', async () => {
  const { base, key, server } = await harness({ videocap: { video: true } });
  try {
    const response = await fetch(`${base}/v1/videos/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'videocap/video-edit', prompt: 'edit' }),
    });
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_SUPPORTED');
    assert.match(body.error.message, /declares video generation, but no generation handler is wired/);
  } finally {
    await close(server);
  }
});

test('a poll is bound to its connection; ?provider= is only a fallback, never a global', async () => {
  // Both adapters refuse video, so a refusal's provider name is the observable binding. An xAI poll
  // would succeed from the scripted transport and could not show which account was selected.
  const { base, key, server } = await harness({ openai: {}, grok: {} });
  try {
    const pinned = await fetch(`${base}/v1/videos/job-1`, {
      headers: { authorization: `Bearer ${key}`, 'x-omnihilbras-connection': 'openai', 'x-omnihilbras-provider': 'grok' },
    });
    const pinnedBody = await pinned.json();
    assert.equal(pinnedBody.error.code, 'NOT_SUPPORTED');
    assert.match(pinnedBody.error.message, /Provider "openai"/, 'the ?provider=/header fallback overrode the creating connection');

    const fallback = await fetch(`${base}/v1/videos/job-2?provider=grok`, { headers: { authorization: `Bearer ${key}` } });
    assert.match((await fallback.json()).error.message, /Provider "grok"/);

    const global = await fetch(`${base}/v1/videos/job-3`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal((await global.json()).error.code, 'INVALID_REQUEST', 'a bare poll was answered from a global job table');

    const unknown = await fetch(`${base}/v1/videos/job-4`, {
      headers: { authorization: `Bearer ${key}`, 'x-omnihilbras-connection': 'not-saved' },
    });
    assert.equal((await unknown.json()).error.code, 'INVALID_REQUEST', 'an unsaved connection was treated as a real account');
  } finally {
    await close(server);
  }
});

test('the route requires the LLM key, and an aborted request is recorded as cancelled', async () => {
  const { base, key, service, recorded, server } = await harness({ xai: {} });
  try {
    const anonymous = await fetch(`${base}/v1/videos/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xai/video', prompt: 'a' }),
    });
    assert.equal(anonymous.status, 401, 'a billable route was reachable without a key');
    assert.equal(key.length > 0, true);

    const controller = new AbortController();
    controller.abort();
    const ctx = {
      request: { method: 'GET', url: '/v1/videos/job-abort', headers: { authorization: `Bearer ${key}`, 'x-omnihilbras-connection': 'xai' } },
      url: new URL('http://localhost/v1/videos/job-abort'),
      service,
      options: {},
      signal: controller.signal,
      origin: undefined,
      response: { setHeader() {}, writeHead() {}, end() {} },
    };
    await assert.rejects(
      handleVideoRoute(ctx),
      (error) => error.code === 'CANCELLED',
    );
    assert.equal(recorded.at(-1).outcome, 'cancelled');
  } finally {
    await close(server);
  }
});
