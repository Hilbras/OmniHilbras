import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, LocalConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { closeStateDatabases } from '../dist/src/core/state-document.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

// The events channel is a change notification, not a data feed. These assert the two properties that matter:
// it is admin-gated like the other management streams, and it emits only "state changed" — never a connection,
// credential or usage record. Change detection is driven by the service's cheap fingerprint.

async function start(t) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('events')).key;
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { failureThreshold: 3 });
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, key, service };
}

/** Saves a fake connection without triggering real provider model discovery (no network, no credential). */
function saveFake(service) {
  return service.saveConnection(
    { id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'http://127.0.0.1:9', priority: 1, proxyPool: 'none', modelPolicy: 'all', credential: { type: 'none' } },
    { type: 'none' },
    undefined,
    { tolerateDiscoveryFailure: true },
  );
}

/** Reads the stream until `predicate(text)` holds or the deadline passes. */
async function until(response, predicate, timeoutMs = 4000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!predicate(text) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('the events stream is an admin route: an unauthenticated caller is refused', async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/v1/events`);
  assert.equal(response.status, 401, 'an unauthenticated caller cannot watch state changes');
});

test('the events stream emits a state notification when a connection changes, and no data', async (t) => {
  const { base, key, service } = await start(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${key}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  // Let the initial fingerprint settle, then change connection state.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await saveFake(service);

  const text = await until(response, (value) => /"type":"state"/.test(value));
  assert.match(text, /data: \{"type":"state"/, 'a state-change notification is emitted');
  assert.doesNotMatch(text, /"name"\s*:\s*"Fake"/, 'no connection data is streamed');
  assert.doesNotMatch(text, /credential|apiKey|apikey|"content"/i, 'no credential or content field is streamed');
});

test('a stable state produces no notification', async (t) => {
  const { base, key } = await start(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${key}` }, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  // Abort after two fingerprint ticks rather than waiting out the 15 s heartbeat.
  const timer = setTimeout(() => controller.abort(), 2200);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Aborting the fetch closes the reader — that is the intended end of this probe.
  } finally {
    clearTimeout(timer);
  }
  assert.doesNotMatch(text, /"type":"state"/, 'with nothing changing, no notification is sent');
});

test('the fingerprint is secret-free and stable', async (t) => {
  const { service } = await start(t);
  const first = await service.stateFingerprint();
  const second = await service.stateFingerprint();
  assert.equal(first, second, 'the same state yields the same fingerprint');
  assert.doesNotMatch(first, /credential|secret|apiKey|apikey|Authorization/i, 'no secret is in the fingerprint');
  await saveFake(service);
  const changed = await service.stateFingerprint();
  assert.notEqual(changed, first, 'a connection change changes the fingerprint');
});


test('a reconnecting client receives the journal events it missed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-events-replay-'));
  const previous = process.env.OMNIHILBRAS_STATE_BACKEND;
  process.env.OMNIHILBRAS_STATE_BACKEND = 'sqlite';
  t.after(async () => {
    closeStateDatabases();
    if (previous === undefined) delete process.env.OMNIHILBRAS_STATE_BACKEND;
    else process.env.OMNIHILBRAS_STATE_BACKEND = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('replay')).key;
  const connections = new LocalConnectionStore({ directory });
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), connections, apiKeys, { config: { dataDir: directory } });
  await connections.save(
    { id: 'replay', providerId: 'replay', name: 'Replay', endpoint: 'http://127.0.0.1:9', priority: 1, proxyPool: 'none', modelPolicy: 'all', credential: { type: 'none' } },
    { type: 'none' },
  );
  // The save wrote the encrypted secrets row (seq 1) and the metadata row (seq 2).
  const events = service.stateEventsSince(1);
  assert.ok(events.length >= 1, 'the write left a journal event');

  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${key}`, 'last-event-id': '1' }, signal: controller.signal });
  const text = await until(response, (value) => /"replay":true/.test(value));
  assert.match(text, /id: \d+/, 'the replayed frame carries an id for the next reconnect');
  assert.match(text, /"type":"state"/);
  assert.doesNotMatch(text, /"name"|credential|apiKey/, 'the journal frame carries no document content');
});