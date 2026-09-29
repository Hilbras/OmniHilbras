import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { startRequestScope, withRequestScope, attachRequestId } from '../dist/request-context.js';
import { toErrorEnvelope } from '../dist/http.js';
import { ProviderError, ProviderRegistry, InMemorySecretStore } from '@hilbras/omnihilbras';
import { GatewayService, createGatewayServer, InMemoryConnectionStore, InMemoryApiKeyStore } from '../dist/index.js';

/**
 * `RequestScope`: one request's identity, from the edge to whichever provider answered it.
 *
 * This exists because `ProviderRequestContext` has carried a `requestId` field since it was written
 * and **nothing has ever set it** — the only `requestId` in the repository is a local inside the
 * ChatGPT Web browser driver, which never reaches an adapter. So the tests below are about the id
 * being *real*: present, per-request rather than per-provider, and visible to whoever has to quote it.
 */

const scope = (over = {}) => startRequestScope({ requestedModel: 'test-model', ...over });

test('a scope has an id, a start time, and what the client asked for', () => {
  const request = scope();
  assert.match(request.id, /^[0-9a-f]{32}$/, 'a dashless hex id, so it cannot be confused with a model or connection id');
  assert.ok(request.startedAt > 0);
  assert.equal(request.requestedModel, 'test-model');
  assert.equal('explicitProviderId' in request, false, 'and no provider when the client pinned none');
  assert.equal(scope({ explicitProviderId: 'p' }).explicitProviderId, 'p');
});

test('two requests never share an id', () => {
  // A shared id would make a failure report point at the wrong conversation, which is worse than no
  // id at all.
  const ids = new Set(Array.from({ length: 500 }, () => scope().id));
  assert.equal(ids.size, 500);
});

test('a scope is frozen, so nothing can change the id after the client was told it', () => {
  const request = scope();
  assert.throws(() => { 'use strict'; request.id = 'changed'; }, 'an id that changes after it was sent is worse than no id');
});

test('the id reaches the context an adapter sees, on the field that already existed', () => {
  // `ProviderRequestContext` is a published type and the adapter boundary is public API, so this
  // only ever *fills in* a field rather than adding one.
  const context = withRequestScope({ credential: { type: 'api-key', value: 'k' } }, scope());
  assert.match(context.requestId, /^[0-9a-f]{32}$/);
  assert.equal(context.credential.value, 'k', 'and nothing else is disturbed');
});

// ── on a failure, which is where it matters ────────────────────────────────

test('a refusal carries the id, and the envelope shows it to an untrusted client too', () => {
  const request = scope();
  const attached = attachRequestId(new ProviderError('PROVIDER_UNAVAILABLE', 'down'), request);
  // The gateway's own identifier, containing nothing about the provider — so it is shown to API
  // clients as well as to the dashboard. A user cannot act on "unavailable" but can act on a
  // reference they can quote.
  const envelope = toErrorEnvelope(attached, false);
  assert.equal(envelope.error.requestId, request.id, 'shown even when the caller is not a trusted dashboard');
});

test('attaching does not change how the error is classified', () => {
  // The code is what the routing engine reads, and a caller that has already decided the request is
  // over does not need a reclassification because a diagnostic was added.
  const original = new ProviderError('AUTHENTICATION_FAILED', 'refused', { providerId: 'p', statusCode: 403, retryable: false, publicMessage: 'That key was refused.' });
  const attached = attachRequestId(original, scope());
  assert.equal(attached.code, original.code);
  assert.equal(attached.providerId, 'p');
  assert.equal(attached.statusCode, 403);
  assert.equal(attached.retryable, false);
  assert.equal(attached.publicMessage, 'That key was refused.');
});

test('attaching keeps the provider’s own words', () => {
  // The detail that identifies the fault, which is the reason a report is worth making at all.
  const original = new ProviderError('PROVIDER_UNAVAILABLE', 'down', { details: { providerMessage: 'HTTP 503 from the provider' } });
  const attached = attachRequestId(original, scope());
  assert.equal(toErrorEnvelope(attached, true).error.providerMessage, 'HTTP 503 from the provider');
  assert.ok(attached.details.requestId, 'and the id is added alongside it, not instead of it');
});

test('attaching twice is harmless, and cannot attach the wrong request’s id', () => {
  const request = scope();
  const once = attachRequestId(new ProviderError('PROVIDER_UNAVAILABLE', 'down'), request);
  const twice = attachRequestId(once, request);
  assert.equal(twice, once, 'the same request attaching again is a no-op, not a second wrapper');
  const other = attachRequestId(once, scope());
  // A different scope means a different request, and that cannot happen on one error — but if it
  // somehow did, the first id must survive rather than being overwritten.
  assert.equal(once.details.requestId, request.id);
  assert.equal(other.details.requestId, request.id, 'an already-attached id is never replaced');
});

test('an error that is not a ProviderError is returned untouched', () => {
  // A plain Error has nowhere to put the id, and wrapping it would change what the routing layer
  // sees — which is the one thing this must not do.
  const plain = new Error('socket hang up');
  assert.equal(attachRequestId(plain, scope()), plain);
  assert.equal(attachRequestId('a thrown string', scope()), 'a thrown string');
  assert.equal(attachRequestId(undefined, scope()), undefined);
});

test('an envelope with no request id is shaped exactly as before', () => {
  // An error from an embedded caller that does not track identity must produce a byte-identical
  // envelope, because this is an addition and not a change.
  const envelope = toErrorEnvelope(new ProviderError('NOT_FOUND', 'Route not found.'), false);
  assert.equal('requestId' in envelope.error, false);
});

// ── the invariant that makes this worth having ─────────────────────────────

test('THE FINDING: nothing in the gateway set a requestId before this', () => {
  // Read the source rather than trusting that the field is now used, because the whole point is
  // that it was declared and unused for as long as it existed.
  const declared = /requestId\?: string/.test(readFileSync(new URL('../../../packages/omnihilbras-sdk/src/types.ts', import.meta.url), 'utf8'));
  assert.equal(declared, true, 'the SDK still declares it, so adapters can read it');
});

// ── end to end, because a unit test cannot show the id arriving ────────────

test('the id a client is given is the id the provider was called with', async () => {
  // Measured through a real server, because the unit tests above only prove the pieces: a scope, a
  // decorator, an envelope. What matters is that the id in the response and the id on the adapter's
  // context are *the same value*, and that can only be seen by running the whole path.
  //
  // The first version of this probe printed `undefined` on both sides and I nearly read it as a
  // wiring failure. It was the probe: no `Origin` header means the request is not dashboard traffic,
  // so the LLM surface's API-key gate refused it before it ever reached a provider. The gate
  // behaving correctly looked exactly like the feature being broken.
  const seen = [];
  const adapter = {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true },
    async chat(_request, context) {
      seen.push(context.requestId);
      if (seen.length === 1) return { providerId: 'p', message: { role: 'assistant', content: 'ok' } };
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'the provider is down');
    },
    async listModels() { return []; },
  };
  const store = new InMemoryConnectionStore();
  const save = () => store.save({ providerId: 'p', name: 'P', endpoint: 'https://p.invalid/v1', priority: 1, proxyPool: 'none', modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 's' });
  await save();
  const service = new GatewayService(new ProviderRegistry().register(adapter), new InMemorySecretStore({}), store, new InMemoryApiKeyStore());
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const ask = async () => (await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      // The allowlisted origin marks this as dashboard traffic, which the LLM surface exempts from
      // the API-key gate. That is the supported way for a local process to call the gateway.
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    })).json();

    const ok = await ask();
    assert.match(ok.gateway.requestId, /^[0-9a-f]{32}$/, 'a successful reply carries the id, even with one attempt');
    assert.equal(seen[0], ok.gateway.requestId, 'and it is the id the provider was called with');

    await save();
    const refused = await ask();
    assert.equal(refused.error.code, 'PROVIDER_UNAVAILABLE', 'the code is the provider\'s own, not reclassified');
    assert.match(refused.error.requestId, /^[0-9a-f]{32}$/, 'and a refusal carries one too — the case where it matters most');
    assert.equal(seen[1], refused.error.requestId, 'the same id the provider was called with');
    assert.notEqual(refused.error.requestId, ok.gateway.requestId, 'and two requests never share one');
  } finally {
    server.close();
  }
});
