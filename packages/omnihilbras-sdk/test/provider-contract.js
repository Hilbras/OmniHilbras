import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The provider contract.
 *
 * The promise this repository makes is that a provider is an adapter and a registration — that
 * adding one needs no edit to routing, execution, health, or the SDK core. A promise like that
 * needs something that holds it in place, and that is this file: a set of invariants the Core is
 * entitled to assume, checked against every adapter that claims to be one.
 *
 * ## The division of labour, which is the whole design
 *
 * The contract owns the **invariants**. The provider supplies only its **wire shape** — how to
 * script an upstream that returns a known multi-part answer. Asking a provider to describe its own
 * expectations would make this a second copy of its tests; asking it only how to speak its own
 * protocol makes this a real contract, because the assertions live in one place and cannot drift
 * per provider.
 *
 * That split exists because of a bug this suite is named after. DeepSeek Web's decoder tests
 * asserted that two hand-written frame shapes were read correctly, and passed — while every real
 * answer was being truncated to its first character, because live traffic arrives as a run of
 * bare-string frames the fixture did not contain. A test that constructs its own input and then
 * asserts against that same input proves the decoder agrees with the author of the test. So the
 * centrepiece here is deliberately hostile to that: **every completion fixture here is
 * multi-part**, and the assertion is exact equality, because a single-part fixture cannot detect
 * a dropped part.
 *
 * ## What the Core relies on, and therefore what is asserted
 *
 * 1. Declared capabilities have implementations. Routing picks `streamChat` because an adapter said
 *    it could stream; a capability flag without the method is a Core crash.
 * 2. Errors are `ProviderError` with a code from the known set. The routing engine decides whether
 *    to retry or fail over by reading `error.code` and nothing else — it must never have to know
 *    which provider produced it.
 * 3. Models are attributed to the adapter that returned them. Usage and routing both read
 *    `providerId`; a model attributed to nobody cannot be billed or ejected.
 * 4. A refusal names a specific code. `AUTHENTICATION_FAILED` and `RATE_LIMITED` fail over
 *    differently from `INVALID_REQUEST`, which must not be retried at all.
 * 5. Health reports what it measured, and never throws. A health check that throws breaks the
 *    sweep that contains it.
 * 6. Text survives the round trip exactly. Not "looks right" — equal, including a part that could
 *    plausibly be dropped.
 */

/** The codes the routing engine is allowed to see. Mirrors `errors.ts`, deliberately not imported. */
const KNOWN_ERROR_CODES = new Set([
  'NOT_SUPPORTED',
  'NOT_FOUND',
  'INVALID_REQUEST',
  'AUTHENTICATION_FAILED',
  'RATE_LIMITED',
  'PROVIDER_REQUEST_FAILED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'INVALID_RESPONSE',
  'CANCELLED',
  'CONFIGURATION_ERROR',
]);

const HEALTH_STATUSES = new Set(['healthy', 'degraded', 'unavailable']);

/**
 * The answer every completion fixture is built from.
 *
 * Six parts, and deliberately awkward: the last one is a lone space, so a decoder that trims each
 * frame instead of the whole answer loses it, and one part repeats a prefix of another, so
 * deduplication shows up as a failure. Real streams are not tidy and a fixture that is tidy tests
 * nothing.
 */
export const CONTRACT_PARTS = ['Hello', ', ', 'world', ' — ', 'a', ' '];
export const CONTRACT_TEXT = CONTRACT_PARTS.join('');

/**
 * Runs the contract against one provider.
 *
 * @param provider.name    a label used only in assertion messages
 * @param provider.adapter the adapter under test
 * @param provider.script  installs an upstream answer. `(parts, { refuseWith }) => cleanup`
 */
export function runProviderContract({ name, adapter, script, credential = { type: 'api-key', value: 'contract-test-key' } }) {
  /**
   * A real request always carries a credential, so the contract must supply one.
   *
   * Omitting it produced a suite where every execution assertion failed with "Missing API key"
   * for five different providers — which looks exactly like five provider bugs and is none. An
   * assertion that fails for a reason the provider did not choose is a broken assertion.
   */
  const context = { credential };
  test(`${name}: declares an id and a name a person can read`, () => {
    assert.equal(typeof adapter.id, 'string', 'id must be a string');
    assert.ok(adapter.id.trim().length > 0, 'id must not be empty');
    assert.match(adapter.id, /^[a-z0-9][a-z0-9._-]*$/, `id ${JSON.stringify(adapter.id)} is not a slug`);
    assert.equal(typeof adapter.name, 'string', 'name must be a string');
    assert.ok(adapter.name.trim().length > 0, 'name must not be empty');
  });

  test(`${name}: every declared capability has an implementation`, () => {
    const capabilities = adapter.capabilities ?? {};
    // The Core dispatches on these flags, so a flag without a method is not a degraded path, it
    // is a crash at the moment the flag is first trusted.
    if (capabilities.streaming === true) {
      assert.equal(typeof adapter.streamChat, 'function', 'declares streaming but has no streamChat');
    }
    if (capabilities.models === true) {
      assert.equal(typeof adapter.listModels, 'function', 'declares models but has no listModels');
    }
    if (capabilities.chat === true) {
      assert.equal(typeof adapter.chat, 'function', 'declares chat but has no chat');
    }
  });

  test(`${name}: a streaming adapter's chunks concatenate to the whole answer`, async () => {
    if (adapter.capabilities?.streaming !== true) return;
    const cleanup = script(CONTRACT_PARTS);
    try {
      const chunks = [];
      for await (const chunk of adapter.streamChat({ model: await firstModel(adapter, context), messages: [{ role: 'user', content: 'hi' }] }, context)) {
        if (chunk.delta?.content) chunks.push(chunk.delta.content);
      }
      assert.equal(chunks.join(''), CONTRACT_TEXT, 'a stream dropped or reordered part of the answer');
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a chat adapter returns the whole answer, not an opening fragment`, async () => {
    if (adapter.capabilities?.chat !== true) return;
    const cleanup = script(CONTRACT_PARTS);
    try {
      const response = await adapter.chat({ model: await firstModel(adapter, context), messages: [{ role: 'user', content: 'hi' }] }, context);
      assert.equal(response.message.role, 'assistant');
      // Exact equality, and the fixture is multi-part, so a decoder that keeps only the first
      // fragment cannot pass. This is the assertion DeepSeek Web's own test file lacked.
      assert.equal(response.message.content, CONTRACT_TEXT, 'the answer was truncated, reordered, or padded');
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a refusal is a ProviderError with a code the router can act on`, async () => {
    if (adapter.capabilities?.chat !== true) return;
    const cleanup = script(CONTRACT_PARTS, { refuseWith: 401 });
    try {
      await assert.rejects(
        async () => adapter.chat({ model: await firstModel(adapter, context), messages: [{ role: 'user', content: 'hi' }] }, context),
        (error) => {
          // The routing engine reads `code` and nothing else. A plain Error, or a code outside
          // the set, means it cannot decide whether to retry, fail over, or stop.
          assert.equal(error.name, 'ProviderError', 'refusals must be ProviderError so routing can classify them');
          assert.ok(KNOWN_ERROR_CODES.has(error.code), `unknown error code ${JSON.stringify(error.code)}`);
          assert.ok(typeof error.message === 'string' && error.message.length > 0, 'a refusal must carry a message');
          return true;
        },
      );
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a refusal names the specific cause rather than a generic failure`, async () => {
    if (adapter.capabilities?.chat !== true) return;
    const cleanup = script(CONTRACT_PARTS, { refuseWith: 401 });
    try {
      await adapter.chat({ model: await firstModel(adapter, context), messages: [{ role: 'user', content: 'hi' }] }, context).catch((error) => {
        // 401 is an authentication refusal everywhere. "Something went wrong" would fail over to
        // another provider for no reason and tell the user nothing about the key that is wrong.
        assert.equal(error.code, 'AUTHENTICATION_FAILED', `a 401 mapped to ${error.code}`);
      });
    } finally {
      await cleanup();
    }
  });

  test(`${name}: models are attributed to the adapter that returned them`, async () => {
    if (adapter.capabilities?.models !== true) return;
    const cleanup = script(CONTRACT_PARTS);
    try {
      const models = await adapter.listModels(context);
      assert.ok(Array.isArray(models), 'listModels must return an array');
      assert.ok(models.length > 0, 'listModels returned nothing, so no model can ever be imported');
      for (const model of models) {
        assert.equal(model.providerId, adapter.id, `model ${model.id} is attributed to ${model.providerId}`);
        assert.ok(typeof model.id === 'string' && model.id.trim().length > 0, 'a model has no id');
      }
      assert.equal(new Set(models.map((model) => model.id)).size, models.length, 'duplicate model ids');
    } finally {
      await cleanup();
    }
  });

  test(`${name}: health reports a status from the known set and never throws`, async () => {
    if (typeof adapter.healthCheck !== 'function') return;
    const cleanup = script(CONTRACT_PARTS);
    try {
      // A health check that throws takes down the sweep that contains it, so the Core's
      // containment is a fallback rather than the design.
      const health = await adapter.healthCheck(context);
      assert.ok(HEALTH_STATUSES.has(health.status), `unknown health status ${JSON.stringify(health.status)}`);
      assert.ok(typeof health.checkedAt === 'string' && health.checkedAt.length > 0, 'health must say when it was measured');
      if (health.status !== 'healthy') {
        assert.ok(typeof health.message === 'string' && health.message.length > 0, 'an unhealthy result must carry a reason');
      }
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a missing credential is refused by name, not as an internal error`, async () => {
    if (typeof adapter.validateCredential !== 'function') return;
    await adapter.validateCredential(undefined, context).then(
      () => {
        // Accepting nothing is allowed, but a provider that *requires* a credential cannot do it.
        if (adapter.capabilities?.requiresCredential === true) {
          assert.fail('a provider that requires a credential accepted none');
        }
      },
      (error) => {
        assert.equal(error.name, 'ProviderError');
        assert.ok(KNOWN_ERROR_CODES.has(error.code), `unknown error code ${JSON.stringify(error.code)}`);
        assert.ok(typeof error.publicMessage === 'string' && error.publicMessage.length > 0, 'a user-facing refusal must have a publicMessage');
      },
    );
  });
}

/** The first model the adapter offers, so the fixtures do not have to know its catalog. */
async function firstModel(adapter, context) {
  if (typeof adapter.listModels === 'function') {
    const models = await adapter.listModels(context).catch(() => []);
    if (models.length > 0) return models[0].id;
  }
  return 'contract-test-model';
}
