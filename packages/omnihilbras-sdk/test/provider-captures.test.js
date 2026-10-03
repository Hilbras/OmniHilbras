import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Real provider wire formats, pinned.
 *
 * ## Why these are shapes and not snapshots
 *
 * The first attempt saved OpenRouter's whole `/models` response: **1.28 MB, 466 models**, a catalog that
 * changes daily. Committing it would make the fixture permanent churn, and any assertion about a count
 * would be a flake. Worse, the point of a fixture is not *what the provider said today* but *the shape it
 * speaks in* — so if OpenRouter renames `canonical_slug` or moves `pricing`, the fixture should fail, and
 * a new model appearing should not.
 *
 * Each capture therefore pins **every key and its type**, drops the values, and keeps a few long-lived
 * model ids so the adapter's parsing can be exercised against real data. A renamed field still
 * disappears; a weekly price change does not churn the file.
 *
 * ## What each capture cost
 *
 * Nothing. Every one of these is a **model listing**, which generates no tokens and is not billed. No
 * completion was requested. The capture script reads the operator's own encrypted vault in memory, so no
 * provider credential was written, logged, or printed — and redaction runs over the bytes before they
 * reach a file.
 *
 * ## The two traps this file exists to avoid
 *
 * 1. **Capturing our own output.** The first attempt asked the *gateway* to refresh a connection and
 *    saved `{"connection": {..., "modelIds": [...]}}`. That is our normalised shape, not the provider's —
 *    it would still pass after OpenRouter renamed every field, because the only field it checked is one
 *    we wrote. Two such files were written and deleted. Every capture here goes through the **adapter**
 *    with a recording transport, so the bytes are the provider's.
 * 2. **A capture that pins nothing.** `opencode-console` was first captured as a one-element array,
 *    because its `listModels` calls `/api/orgs` and `/api/config` and builds ids itself — there is no
 *    `data` array to slice. That file looked like coverage and asserted nothing. It now pins both
 *    responses, which is the real wire format for that adapter.
 *
 * ## What is genuinely still missing
 *
 * `openai`, `openai-compatible`, `anthropic`, `gemini`, `zen` and `zen-free-tier` have **no credential on
 * this machine**, so no capture of them can be taken. That is a credential question, not a design one.
 * `chatgpt-web` and `deepseek-web` are browser DOM sessions, and `fixture-coverage.test.js` argues why a
 * byte capture pins nothing useful for those.
 */
const FIXTURES = new URL('./fixtures/', import.meta.url);

function capture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

test('the OpenRouter capture is the provider shape, not ours', () => {
  const captured = capture('openrouter-models.json');
  const [response] = captured.responses;

  // These three keys ARE the OpenRouter envelope. If they are renamed the adapter breaks and this fails.
  assert.deepEqual(
    response.topLevelKeys,
    ['data', 'links', 'total_count'],
    "OpenRouter's models envelope changed; the adapter reads `data`, and this is what pins that",
  );

  // The per-item keys are the part that silently rotting looks like: a renamed field is invisible to a
  // test that only checks `data[0].id` exists.
  const keys = Object.keys(response.itemShape[0]);
  for (const expected of ['id', 'name', 'created', 'context_length', 'pricing', 'architecture', 'supported_parameters']) {
    assert.ok(keys.includes(expected), `OpenRouter no longer sends \`${expected}\` — the item shape changed`);
  }

  // Types are the contract: `pricing` must stay an object with prompt/completion, `created` a number.
  const shape = response.itemShape[0];
  assert.equal(shape.created, 'number', '`created` must remain a timestamp');
  assert.equal(shape.context_length, 'number', '`context_length` must remain a number');
  // Keys are sorted, so the order is `completion,prompt` — assert the members, not an ordering.
  assert.match(shape.pricing, /^object\{completion,prompt\}$/, '`pricing` must keep exactly its prompt and completion keys');
  assert.match(shape.architecture, /^object\{/, '`architecture` must stay an object');
});

test('the Cline capture pins a DIFFERENT envelope over the SAME catalog', () => {
  const cline = capture('cline-models.json').responses[0];
  const openrouter = capture('openrouter-models.json').responses[0];

  // This is the finding worth keeping. Cline and OpenRouter serve an identical model list — the ids match
  // exactly — but in different envelopes. A capture of one says nothing about the other, which is why
  // "it shares the OpenAI wire format, so a capture would duplicate that one" was the wrong reason to skip
  // it: the *shape* differs even though the catalog does not.
  assert.deepEqual(cline.sampleIds, openrouter.sampleIds, 'the two catalogs should still be identical; if not, that is worth knowing too');
  assert.notDeepEqual(
    cline.topLevelKeys,
    openrouter.topLevelKeys,
    'if these envelopes became identical, one of the two captures is redundant and the reason should change',
  );

  assert.deepEqual(cline.topLevelKeys, ['data', 'object'], "Cline's envelope changed");
  // Cline's items are the bare OpenAI `list` shape, with no pricing and no architecture block.
  const keys = Object.keys(cline.itemShape[0]);
  // `keys` is insertion order (the provider's own), not sorted, so this asserts the exact order too.
  assert.deepEqual(keys, ['id', 'object', 'created', 'owned_by'], "Cline's item shape changed");
  assert.ok(!keys.includes('pricing'), 'Cline must not gain a pricing block without this fixture noticing');
});

test('the opencode-console capture pins both responses its model list is built from', () => {
  const captured = capture('opencode-console-models.json');
  const urls = captured.responses.map((response) => response.url);

  // `listModels` hits these two and derives ids itself, so capturing a `data` array would pin nothing.
  assert.ok(urls.some((url) => url.includes('/api/orgs')), 'the orgs call is part of its wire format');
  assert.ok(urls.some((url) => url.includes('/api/config')), 'the config call is part of its wire format');

  const orgs = captured.responses.find((response) => response.url.includes('/api/orgs'));
  assert.match(orgs.shape, /^array<.*\{.*id.*name/, 'orgs must stay an array of {id, name}');

  const config = captured.responses.find((response) => response.url.includes('/api/config'));
  assert.deepEqual(config.topLevelKeys, ['config'], "the config response's envelope changed");
});

test('every capture records how it was taken and carries no credential', () => {
  for (const name of ['openrouter-models.json', 'cline-models.json', 'opencode-console-models.json']) {
    const captured = capture(name);
    const meta = captured._capture;

    assert.ok(meta.provider, `${name} does not say which provider it came from`);
    assert.ok(meta.url?.startsWith('https://'), `${name} must record an https URL`);
    assert.ok(meta.how?.length > 30, `${name} must record HOW it was captured, not just that it was`);
    assert.match(meta.how, /no tokens|billed/i, `${name} must record that the capture cost nothing`);

    // A fixture is committed, so a credential in one is a credential in git history forever. This is the
    // check the repo's own secret scanner cannot make: it reads source files, not JSON fixtures.
    const raw = readFileSync(new URL(name, FIXTURES), 'utf8');
    for (const pattern of [/\b(?:sk|clp|ohk|key|tok|v1)[-_][A-Za-z0-9_-]{16,}/g, /\beyJ[A-Za-z0-9._-]{20,}/g]) {
      assert.equal(pattern.test(raw), false, `${name} contains a token-shaped string`);
    }
    // The capture stores types and a few public model ids — never a live key or a bearer token.
    assert.equal(/Bearer\s+(?!\[redacted\])\S{16,}/.test(raw), false, `${name} contains a bearer token`);
  }
});

test('every capture is small enough to read and stable enough not to churn', () => {
  // A fixture nobody opens is a fixture nobody trusts, and a 1.28MB one is a merge conflict generator.
  // The untrimmed OpenRouter response was 1,286,456 bytes; this is the shape of it.
  for (const name of ['openrouter-models.json', 'cline-models.json', 'opencode-console-models.json']) {
    const bytes = readFileSync(new URL(name, FIXTURES)).byteLength;
    assert.ok(bytes < 20_000, `${name} is ${bytes} bytes — a snapshot, not a shape; trim it`);
  }
});