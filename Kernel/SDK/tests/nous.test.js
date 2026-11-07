import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NousAdapter, NOUS_BASE_URL, NOUS_FALLBACK_VALIDATION_MODEL, nousProviderId } from '../nous/dist/adapter/index.js';
import { ProviderError } from '../nous/dist/lib/errors.js';

/**
 * Nous Research — the two facts the reference project measured about this provider, and the adapter
 * that acts on them:
 *
 * 1. `/models` is **public**, so reading it does not validate a key. Only a 1-token inference does.
 * 2. The catalog is not all chat models: embeddings and image-only entries are listed beside them.
 *
 * Both are asserted here against a scripted transport, so no request reaches the provider.
 */

function transportFor(handler) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      const answer = await handler(request);
      return { status: answer?.status ?? 200, headers: new Headers(), data: answer?.data ?? { data: [] } };
    },
    async *stream() { throw new Error('not used'); },
  };
}


/**
 * A handler that answers the two requests a credential check makes: the public catalog, then the probe.
 * `probe` decides the second answer, so each test states only what it is about.
 */
function probeHandler({ probe, catalog = { data: { data: [
  { id: 'vendor/paid-model', pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { output_modalities: ['text'] } },
  { id: 'vendor/free-model:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
] } } } = {}) {
  return (request) => {
    if (request.method === 'GET') return catalog;
    return probe ? probe(request) : { data: {} };
  };
}

const CATALOG = {
  data: [
    {
      id: 'vendor/text-model',
      name: 'Vendor Text Model',
      context_length: 262144,
      top_provider: { max_completion_tokens: 65536 },
      architecture: { output_modalities: ['text'] },
      pricing: { prompt: '0.0000005', completion: '0.000001' },
    },
    {
      id: 'vendor/embedding-model',
      architecture: { output_modalities: ['embeddings'] },
    },
    {
      id: 'vendor/image-model',
      architecture: { output_modalities: ['image'] },
    },
    {
      id: 'nousresearch/first-party-model',
      name: 'Nous First Party',
      top_provider: { context_length: 262144 },
      architecture: { output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
    },
    { id: '   ' },
  ],
};

test('the catalog is reduced to chat models, with context and per-1M prices', async () => {
  const transport = transportFor(() => ({ data: CATALOG }));
  const models = await new NousAdapter({ transport }).listModels({ credential: { type: 'api-key', value: 'k' } });

  assert.equal(transport.calls[0].url, `${NOUS_BASE_URL}/models`);
  assert.equal(transport.calls[0].method, 'GET');
  // First-party first, catalog order preserved inside each group.
  assert.deepEqual(models.map((model) => model.id), ['nousresearch/first-party-model', 'vendor/text-model']);
  assert.deepEqual(models[0].pricing, { inputPer1M: 0, outputPer1M: 0 }, 'a free model is a stated zero, not a missing price');
  assert.deepEqual(models[1].pricing, { inputPer1M: 0.5, outputPer1M: 1 });
  assert.equal(models[1].contextWindow, 262144);
  assert.equal(models[1].displayName, 'Vendor Text Model');
  assert.equal(models.every((model) => model.providerId === nousProviderId), true);
});

test('a quantity with no stated modalities is kept, because silence is not evidence it is not chat', async () => {
  const transport = transportFor(() => ({ data: { data: [{ id: 'vendor/silent-model' }] } }));
  const models = await new NousAdapter({ transport }).listModels();
  assert.deepEqual(models.map((model) => model.id), ['vendor/silent-model']);
  assert.equal(models[0].pricing, undefined, 'nothing was stated, so nothing is shown — not a zero price');
});

test('the credential check is an authenticated inference request, not a catalog read', async () => {
  const transport = transportFor(probeHandler());
  const result = await new NousAdapter({ transport }).validateCredential({ type: 'api-key', value: 'sk-nous' });

  const probe = transport.calls.find((call) => call.method === 'POST');
  assert.ok(probe, 'a check that only read the catalog would accept any key');
  assert.equal(probe.url, `${NOUS_BASE_URL}/chat/completions`);
  assert.equal(probe.headers.Authorization, 'Bearer sk-nous');
  const body = JSON.parse(probe.body);
  assert.equal(body.model, 'vendor/free-model:free', 'the probe must not spend paid credits');
  assert.equal(body.max_tokens, 1);
  assert.equal(body.stream, false);
  assert.equal(result.status, 'valid');
});

test('the probe model is read from the live catalog, so a rotated id cannot fail every key', async () => {
  // The reference project pinned one free model, and by 2026-11 that id answered `404 Model not found`.
  // Reading the catalog means the probe follows the listings instead of a constant that rots.
  const transport = transportFor(probeHandler());
  const adapter = new NousAdapter({ transport });
  await adapter.validateCredential({ type: 'api-key', value: 'sk-1' });
  const firstGet = transport.calls.findIndex((call) => call.method === 'GET');
  assert.ok(firstGet >= 0, 'the probe model must come from the catalog');
  assert.ok(transport.calls[firstGet].url.endsWith('/models'));

  // Within the cache window a second check reuses the model: one catalog read, not one per check.
  const before = transport.calls.length;
  await adapter.validateCredential({ type: 'api-key', value: 'sk-1' });
  assert.equal(transport.calls.slice(before).filter((call) => call.method === 'GET').length, 0, 'the chosen model is reused');
});

test('a probe model Nous no longer lists is a catalog problem, not a bad key', async () => {
  const transport = transportFor(probeHandler({
    probe: () => { throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider rejected the request.', { statusCode: 404 }); },
  }));
  await assert.rejects(
    () => new NousAdapter({ transport }).validateCredential({ type: 'api-key', value: 'sk-fine' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.publicMessage, /Nothing is wrong with the key/);
      return true;
    },
  );
});

test('a catalog that cannot be read falls back to the pinned free model', async () => {
  const transport = transportFor((request) => {
    if (request.method === 'GET') throw new ProviderError('PROVIDER_UNAVAILABLE', 'catalog down');
    return { data: {} };
  });
  await new NousAdapter({ transport }).validateCredential({ type: 'api-key', value: 'sk-nous' });
  const probe = transport.calls.find((call) => call.method === 'POST');
  assert.equal(JSON.parse(probe.body).model, NOUS_FALLBACK_VALIDATION_MODEL);
  assert.match(NOUS_FALLBACK_VALIDATION_MODEL, /:free$/);
});

test('a refused key is an authentication failure that names the provider', async () => {
  for (const status of [401, 403]) {
    const transport = transportFor(probeHandler({
      probe: () => { throw new ProviderError('AUTHENTICATION_FAILED', 'Provider authentication failed.', { statusCode: status }); },
    }));
    await assert.rejects(
      () => new NousAdapter({ transport }).validateCredential({ type: 'api-key', value: 'bad' }),
      (error) => {
        assert.equal(error.code, 'AUTHENTICATION_FAILED');
        assert.match(error.publicMessage, /refused this key/);
        return true;
      },
      `${status} must read as a refused key`,
    );
  }
});

test('a refusal from a different copy of the SDK is still read by its status', async () => {
  // The gateway supplies the transport, and it has its own vendored `lib/`, so an error it throws is not
  // an instance of this package's ProviderError. `instanceof` made a live 401 read as "could not verify
  // (no status)" — measured by saving a bogus key through a running gateway. The status is read
  // structurally for that reason.
  const foreign = Object.assign(new Error('Provider authentication failed.'), { code: 'AUTHENTICATION_FAILED', statusCode: 401 });
  const transport = transportFor(probeHandler({ probe: () => { throw foreign; } }));
  await assert.rejects(
    () => new NousAdapter({ transport }).validateCredential({ type: 'api-key', value: 'sk-bogus' }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});

test('any other status is "could not verify", not "bad key"', async () => {
  const transport = transportFor(probeHandler({
    probe: () => { throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider rejected the request.', { statusCode: 429 }); },
  }));
  await assert.rejects(
    () => new NousAdapter({ transport }).validateCredential({ type: 'api-key', value: 'k' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.message, /429/);
      return true;
    },
  );
});

test('a missing key is named before a request is made', async () => {
  const transport = transportFor(() => ({ data: {} }));
  await assert.rejects(
    () => new NousAdapter({ transport }).validateCredential(undefined),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /Enter a Nous Research API key/.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('health says inference, because it really sent one — and says so when refused too', async () => {
  const healthy = transportFor(probeHandler());
  const ok = await new NousAdapter({ transport: healthy }).healthCheck({ credential: { type: 'api-key', value: 'k' } });
  assert.equal(ok.status, 'healthy');
  assert.equal(ok.verified, 'inference', 'a catalog read is not a credential check here; the probe is');
  assert.ok(healthy.calls.some((call) => call.method === 'POST' && call.url === `${NOUS_BASE_URL}/chat/completions`));

  const refused = transportFor(probeHandler({
    probe: () => { throw new ProviderError('AUTHENTICATION_FAILED', 'Provider authentication failed.', { statusCode: 401 }); },
  }));
  const down = await new NousAdapter({ transport: refused }).healthCheck({ credential: { type: 'api-key', value: 'bad' } });
  assert.equal(down.status, 'unavailable');
  assert.equal(down.verified, 'inference', 'the attempt was still an inference request');
  assert.match(down.message, /Invalid or inactive/);

  const keyless = await new NousAdapter({ transport: transportFor(probeHandler()) }).healthCheck();
  assert.equal(keyless.status, 'unavailable');
  assert.match(keyless.message, /No Nous Research key/);
});

test('the pinned capture decodes: the real catalog shape, through the adapter', async () => {
  // The bytes below are the provider's own entries, read from the public listing on 2026-11-07 — the
  // shape as it really is, not as this file imagines it. What it pins is the two decisions the reference
  // project measured: an embeddings entry is not a chat model, and a per-token price becomes a per-1M one.
  const capture = JSON.parse(readFileSync(new URL('./fixtures/nous-models.json', import.meta.url), 'utf8'));
  const items = capture.responses[0].items;
  assert.ok(items.some((item) => (item.architecture?.output_modalities ?? []).includes('embeddings')), 'the capture still contains a non-chat entry, or it no longer tests the filter');

  const transport = transportFor(() => ({ data: { data: items } }));
  const models = await new NousAdapter({ transport }).listModels();
  const ids = models.map((model) => model.id);

  assert.equal(ids.includes('cohere/embed-5-fast'), false, 'an embeddings model must not be offered as chat');
  assert.ok(ids.includes('upstage/solar-mini4:free'));
  const free = models.find((model) => model.id === 'upstage/solar-mini4:free');
  assert.deepEqual(free.pricing, { inputPer1M: 0, outputPer1M: 0 }, 'a zero price is stated, not dropped');
  const paid = models.find((model) => model.id.startsWith('liquid/'));
  assert.ok(paid.pricing.inputPer1M > 0 && paid.pricing.outputPer1M > 0, 'a captured per-token price is converted to per-1M');
  assert.ok(paid.contextWindow >= 1024, 'the context window is read from the listing');
});


// ── the portal sign-in, beside the API key ────────────────────────────────────

/** A handler for the portal's three endpoints, so each test states only the step it is about. */
function portalHandler({ device = { device_code: 'dev-1', user_code: 'NOUS-1234', verification_uri: 'https://portal.nousresearch.com/device', expires_in: 900 }, token = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }, agentKey = { status: 200, data: { api_key: 'sk-agent-1', expires_at: '2030-01-01T00:00:00Z' } } } = {}) {
  const calls = [];
  return {
    calls,
    handler: (request) => {
      calls.push(request);
      if (request.url.endsWith('/api/oauth/device/code')) return { data: device };
      if (request.url.endsWith('/api/oauth/agent-key')) return agentKey;
      return { status: token.error ? 400 : 200, data: token };
    },
  };
}

test('the sign-in asks the portal for a device code, form-encoded', async () => {
  const portal = portalHandler();
  const adapter = new NousAdapter({ transport: transportFor((request) => portal.handler(request)) });
  const started = await adapter.beginSignIn();

  const call = portal.calls[0];
  assert.equal(call.url, 'https://portal.nousresearch.com/api/oauth/device/code');
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(call.body)), {
    client_id: 'hermes-cli',
    scope: 'inference:invoke inference:mint_agent_key',
  });
  assert.deepEqual(started, {
    deviceCode: 'dev-1',
    userCode: 'NOUS-1234',
    verificationUrl: 'https://portal.nousresearch.com/device',
    expiresIn: 900,
  });
});

test('a pending poll is a wait, not a refusal', async () => {
  const portal = portalHandler({ token: { error: 'authorization_pending' } });
  const outcome = await new NousAdapter({ transport: transportFor((request) => portal.handler(request)) }).pollSignIn('dev-1');
  assert.deepEqual(outcome, { status: 'pending' });
});

test('an approved poll mints an agent key, which is what the credential carries', async () => {
  const portal = portalHandler();
  const outcome = await new NousAdapter({ transport: transportFor((request) => portal.handler(request)) }).pollSignIn('dev-1');

  assert.equal(outcome.status, 'connected');
  assert.equal(outcome.credential.value, 'sk-agent-1', 'the inference host wants the agent key, not the access token');
  assert.equal(outcome.credential.refreshToken, 'rt-1');
  assert.equal(outcome.credential.expiresAt, '2030-01-01T00:00:00.000Z', 'the agent key states its own expiry');
  assert.equal(outcome.credential.oauthClientId, 'hermes-cli');
  const mint = portal.calls.find((call) => call.url.endsWith('/api/oauth/agent-key'));
  assert.equal(mint.headers.Authorization, 'Bearer at-1');
  assert.deepEqual(JSON.parse(mint.body), { min_ttl_seconds: 7200 });
});

test('a mint that fails keeps the sign-in, with the access token as the bearer', async () => {
  const portal = portalHandler({ agentKey: { status: 500, data: {} } });
  const outcome = await new NousAdapter({ transport: transportFor((request) => portal.handler(request)) }).pollSignIn('dev-1');
  assert.equal(outcome.status, 'connected');
  assert.equal(outcome.credential.value, 'at-1', 'discarding a working sign-in over a convenience token is the wrong trade');
});

test('a refused grant is denied, with the portal’s own words', async () => {
  const portal = portalHandler({ token: { error: 'access_denied', error_description: 'The user refused the request.' } });
  const outcome = await new NousAdapter({ transport: transportFor((request) => portal.handler(request)) }).pollSignIn('dev-1');
  assert.deepEqual(outcome, { status: 'denied', error: 'The user refused the request.' });
});

test('an expired credential is renewed, and the renewal is memoised', async () => {
  let refreshes = 0;
  const stored = [];
  const transport = transportFor((request) => {
    if (request.url.endsWith('/api/oauth/token')) {
      const fields = Object.fromEntries(new URLSearchParams(request.body));
      if (fields.grant_type === 'refresh_token') {
        refreshes += 1;
        return { data: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } };
      }
      return { data: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } };
    }
    if (request.url.endsWith('/api/oauth/agent-key')) return { data: { api_key: `sk-agent-${refreshes}`, expires_at: '2030-01-01T00:00:00Z' } };
    if (request.url.endsWith('/chat/completions')) {
      return { data: { id: 'x', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
    }
    return { data: { data: [] } };
  });
  const adapter = new NousAdapter({ transport, onTokensRefreshed: (credential) => { stored.push(credential); } });
  const expired = { type: 'oauth', value: 'sk-agent-0', refreshToken: 'rt-1', expiresAt: '2020-01-01T00:00:00.000Z' };

  const first = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: expired });
  const second = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: expired });

  assert.equal(refreshes, 1, 'one expiry costs one renewal, not one per request');
  assert.equal(stored.length, 1, 'and the replacement is handed to storage, so it outlives the request');
  assert.equal(stored[0].refreshToken, 'rt-2');
  assert.equal(first.model, 'm');
  assert.equal(second.model, 'm');
});

test('an expired credential with no refresh token says so instead of pretending', async () => {
  const adapter = new NousAdapter({ transport: transportFor(() => ({ data: { data: [] } })) });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [] }, { credential: { type: 'oauth', value: 'sk-old', expiresAt: '2020-01-01T00:00:00.000Z' } }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /expired/.test(error.message),
  );
});

test('expiry is answered without a request, and answered "cannot say" when it cannot be read', () => {
  const adapter = new NousAdapter({ transport: transportFor(() => ({ data: {} })) });
  assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'v', expiresAt: '2020-01-01T00:00:00.000Z' }), true);
  assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'v', expiresAt: '2030-01-01T00:00:00.000Z' }), false);
  assert.equal(adapter.isCredentialExpired({ type: 'api-key', value: 'v' }), undefined, 'a key has no expiry to read');
  assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'v', expiresAt: 'not-a-date' }), undefined, 'unreadable is not "not expired"');
});
