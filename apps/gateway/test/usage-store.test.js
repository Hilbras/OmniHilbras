import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORBIDDEN_RECORD_FIELDS,
  InMemoryUsageStore,
  LocalUsageStore,
  defaultMaxUsageRecords,
  selectUsageRecords,
  summarizeUsage,
} from '../dist/usage-store.js';

// The usage store is the first thing in this gateway that records anything about a request, so the tests
// start from the constraint rather than the feature: **what must never be written**. A prompt is a
// prompt-injection target and a privacy liability, and neither is what "what did that cost me" needs. That is
// a property of the record's shape, so it is asserted against the shape.

const entry = (overrides = {}) => ({
  at: '2026-10-04T10:00:00.000Z',
  model: 'claude-sonnet-4',
  providerId: 'anthropic',
  connectionId: 'conn-1',
  outcome: 'success',
  attempts: 1,
  latencyMs: 420,
  inputTokens: 1200,
  outputTokens: 340,
  ...overrides,
});

test('a record cannot hold content, headers or credentials — by construction', async () => {
  const store = new InMemoryUsageStore();
  await store.record(entry());

  const [record] = await store.list();
  const keys = Object.keys(record);
  for (const forbidden of FORBIDDEN_RECORD_FIELDS) {
    assert.ok(
      !keys.includes(forbidden),
      `a usage record has a \`${forbidden}\` field; usage records must not be able to hold content or credentials`,
    );
  }
});

test('the forbidden-field list is enforced against the real record, not a copy', async () => {
  // Reading the list and asserting nothing about the code would pass forever. The list is compared to the
  // keys the store actually produces, so a field added to `UsageRecord` without being listed fails here.
  const store = new InMemoryUsageStore();
  const record = await store.record(entry());
  const produced = new Set(Object.keys(record));
  const listed = new Set(FORBIDDEN_RECORD_FIELDS);
  // Nothing forbidden is produced, and nothing produced is forbidden — both directions.
  for (const key of produced) assert.ok(!listed.has(key), `\`${key}\` is produced but not on the forbidden list`);
});

test('an unknown key on the input is dropped, not stored', async () => {
  // The type system stops this in TypeScript; JavaScript callers and a hand-edited file do not. Normalization
  // is what makes the guarantee real rather than advisory.
  const store = new InMemoryUsageStore();
  const record = await store.record({ ...entry(), messages: [{ role: 'user', content: 'my secret prompt' }], apiKey: 'sk-nope' });
  assert.ok(!('messages' in record), 'a `messages` key survived normalization');
  assert.ok(!('apiKey' in record), 'an `apiKey` key survived normalization');
  assert.ok(!JSON.stringify(record).includes('my secret prompt'));
  assert.ok(!JSON.stringify(record).includes('sk-nope'));
});

test('the store is bounded, and bounded on write rather than on read', async () => {
  // A store trimmed only in `list()` grows until someone reads it. `size()` is checked directly, with no
  // read in between.
  const store = new InMemoryUsageStore({ maxRecords: 10 });
  for (let index = 0; index < 250; index += 1) await store.record(entry({ at: new Date(1_700_000_000_000 + index).toISOString() }));
  assert.equal(await store.size(), 10, 'the store grew past its bound without a read');
  assert.equal((await store.list()).length, 10);
});

test('the newest record is first, and eviction drops the oldest', async () => {
  const store = new InMemoryUsageStore({ maxRecords: 3 });
  for (let index = 0; index < 5; index += 1) await store.record(entry({ model: `m${index}` }));
  const models = (await store.list()).map((record) => record.model);
  assert.deepEqual(models, ['m4', 'm3', 'm2'], `expected newest-first with the oldest evicted, got ${models.join(',')}`);
});

test('a cancellation is counted as neither success nor failure', async () => {
  // The v1.52.0 rule, applied to the record rather than to health: cancelling is the user's decision and must
  // not be scored as an outcome the provider produced.
  const store = new InMemoryUsageStore();
  await store.record(entry({ outcome: 'success' }));
  await store.record(entry({ outcome: 'failure', errorCode: 'RATE_LIMITED' }));
  await store.record(entry({ outcome: 'cancelled' }));

  const { totals } = await store.summary();
  assert.equal(totals.succeeded, 1);
  assert.equal(totals.failed, 1);
  assert.equal(totals.cancelled, 1);
  assert.equal(totals.requests, 3);
});

test('unmetered tokens are reported as unmeasured, not as zero', async () => {
  // A provider that does not report tokens and a free provider both sum to 0. Only one of them is a
  // measurement, so the summary says which it is rather than letting a page imply the other.
  const store = new InMemoryUsageStore();
  await store.record(entry({ inputTokens: undefined, outputTokens: undefined }));
  const { totals } = await store.summary();
  assert.equal(totals.tokensUnmeasured, true, 'an unmetered request was presented as a zero-token measurement');
  assert.equal(totals.inputTokens, 0);

  await store.record(entry({ inputTokens: 10, outputTokens: 5 }));
  const mixed = await store.summary();
  assert.equal(mixed.totals.tokensUnmeasured, false, 'one metered request should make the totals real');
  assert.equal(mixed.totals.inputTokens, 10);
});

test('a failure keeps the provider error code rather than a generic message', async () => {
  const store = new InMemoryUsageStore();
  await store.record(entry({ outcome: 'failure', errorCode: 'PROVIDER_TIMEOUT' }));
  const [record] = await store.list();
  assert.equal(record.errorCode, 'PROVIDER_TIMEOUT');
  assert.ok(!('errorMessage' in record), 'a raw error message would be content on disk');
});

test('queries filter by outcome, provider, model and time', async () => {
  const records = [
    entry({ at: '2026-10-01T00:00:00.000Z', providerId: 'anthropic', outcome: 'success' }),
    entry({ at: '2026-10-02T00:00:00.000Z', providerId: 'anthropic', outcome: 'failure' }),
    entry({ at: '2026-10-03T00:00:00.000Z', providerId: 'openai', outcome: 'success' }),
  ];
  const newestFirst = [records[2], records[1], records[0]];

  assert.equal(selectUsageRecords(newestFirst, { providerId: 'anthropic' }).length, 2);
  assert.equal(selectUsageRecords(newestFirst, { outcome: 'success' }).length, 2);
  assert.equal(selectUsageRecords(newestFirst, { since: '2026-10-02T12:00:00.000Z' }).length, 1);
  assert.equal(selectUsageRecords(newestFirst, { until: '2026-10-01T12:00:00.000Z' }).length, 1);
  assert.equal(selectUsageRecords(newestFirst, { limit: 2 }).length, 2);
  assert.equal(selectUsageRecords(newestFirst, { providerId: 'nope' }).length, 0);
});

test('an unparseable timestamp is kept rather than silently dropped', async () => {
  // Dropping it would make the totals disagree with the row count on screen, which is the one thing a usage
  // page must never do.
  const kept = selectUsageRecords([entry({ at: 'not-a-date' })], { since: '2026-10-01T00:00:00.000Z' });
  assert.equal(kept.length, 1, 'a record with an unreadable timestamp vanished from the filtered view');
});

// ---- LocalUsageStore -------------------------------------------------------

function localStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'omnih-usage-'));
  return { directory, store: new LocalUsageStore({ directory, ...options }) };
}

test('the local store persists across instances', async (t) => {
  const { directory, store } = localStore();
  t.after(() => undefined);
  await store.record(entry({ model: 'persisted-model' }));

  const reopened = new LocalUsageStore({ directory });
  const [record] = await reopened.list();
  assert.equal(record.model, 'persisted-model');
});

test('ids stay unique across a restart instead of restarting at 1', async (t) => {
  const { directory, store } = localStore();
  t.after(() => undefined);
  await store.record(entry());
  await store.record(entry());
  const before = (await store.list()).map((record) => record.id);

  const reopened = new LocalUsageStore({ directory });
  const after = (await reopened.list()).map((record) => record.id);
  const added = await reopened.record(entry());

  assert.equal(new Set([...before, ...after, added.id]).size, before.length + 1, 'an id was reused after a restart');
});

test('the usage file is written with the same 0600 as every other secret', async (t) => {
  // Measured on disk, not read from source: the mode is the control, and a code change that drops the chmod
  // would leave the test green if it only read the source.
  const { directory, store } = localStore();
  t.after(() => undefined);
  await store.record(entry());
  const mode = (statSync(join(directory, 'usage.json')).mode & 0o777).toString(8);
  assert.equal(mode, '600', `the usage file is mode ${mode}; it lives beside the credential files and must match them`);
});

test('the file on disk contains no content-shaped field even when handed one', async (t) => {
  const { directory, store } = localStore();
  t.after(() => undefined);
  await store.record({ ...entry(), content: 'the user prompt', headers: { authorization: 'Bearer sk-secret' } });
  const text = readFileSync(join(directory, 'usage.json'), 'utf8');
  assert.ok(!text.includes('the user prompt'), 'a prompt reached the usage file');
  assert.ok(!text.includes('sk-secret'), 'a credential-shaped value reached the usage file');
  assert.ok(!text.includes('authorization'));
});

test('concurrent writes all land — the read-modify-write is serialised', async (t) => {
  // The bug this catches: two `record()` calls interleaving a read and a write of the file, so the second
  // commits a snapshot taken before the first and one record vanishes. `mutationQueue` is the fix, copied
  // from `LocalConnectionStore`.
  const { directory, store } = localStore();
  t.after(() => undefined);
  const total = 120;
  await Promise.all(Array.from({ length: total }, (_, index) => store.record(entry({ model: `m${index}` }))));

  const reopened = new LocalUsageStore({ directory });
  assert.equal(await reopened.size(), total, `lost records under concurrency: ${await reopened.size()} of ${total}`);
});

test('a corrupt file does not stop the gateway — it is replaced on the next write', async (t) => {
  const { directory, store } = localStore();
  t.after(() => undefined);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(directory, 'usage.json'), '{ this is not json');

  const reopened = new LocalUsageStore({ directory });
  assert.equal(await reopened.size(), 0, 'a corrupt file should read as no usage, not as a crash');
  await reopened.record(entry());
  const after = new LocalUsageStore({ directory });
  assert.equal(await after.size(), 1, 'the corrupt file was not replaced on the next write');
});

test('a hand-edited record with an extra field is normalized away on load', async (t) => {
  const { directory } = localStore();
  t.after(() => undefined);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(directory, 'usage.json'), JSON.stringify({
    version: 1,
    records: [{ ...entry(), id: 'req_1', apiKey: 'sk-injected', messages: [{ role: 'user', content: 'injected prompt' }] }],
  }));

  const store = new LocalUsageStore({ directory });
  const [record] = await store.list();
  assert.ok(!('apiKey' in record), 'a hand-edited file could inject an `apiKey` into a record');
  assert.ok(!('messages' in record), 'a hand-edited file could inject message content');
  assert.ok(!JSON.stringify(record).includes('injected prompt'));
});

test('a record of the wrong shape is dropped rather than repaired', async (t) => {
  const { directory } = localStore();
  t.after(() => undefined);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(directory, 'usage.json'), JSON.stringify({
    version: 1,
    records: [
      { ...entry(), id: 'req_1' },                                  // valid
      { ...entry(), id: 'req_2', outcome: 'weird' },                 // unknown outcome
      { ...entry(), id: 'req_3', latencyMs: 'fast' },               // wrong type
      { ...entry(), id: 'req_4', latencyMs: Number.NaN },           // non-finite
      'not an object',
    ],
  }));

  const store = new LocalUsageStore({ directory });
  assert.equal(await store.size(), 1, `expected the one valid record, got ${await store.size()}`);
});

test('the bound is re-applied on load, so a larger file cannot defeat it', async (t) => {
  const { directory } = localStore();
  t.after(() => undefined);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(directory, 'usage.json'), JSON.stringify({
    version: 1,
    records: Array.from({ length: defaultMaxUsageRecords + 500 }, (_, index) => ({ ...entry(), id: `req_${index}` })),
  }));

  const store = new LocalUsageStore({ directory, maxRecords: 100 });
  assert.equal(await store.size(), 100, 'a store trusted a file\'s length instead of its own bound');
});

test('a record may have no provider, because a request can end before any route is tried', async () => {
  // A client that disconnects during startup, or a request nothing could serve, has no provider on it.
  // Measured before this was allowed: 30 such requests produced ZERO records, because the recorder returned
  // early when `providerId` was missing -- so the page's request count was lower than the requests made,
  // with no way for a reader to tell.
  const store = new InMemoryUsageStore();
  const record = await store.record({
    at: '2026-10-04T10:00:00.000Z',
    model: 'm',
    outcome: 'cancelled',
    attempts: 0,
    latencyMs: 5,
  });
  assert.equal(record.providerId, undefined, 'a placeholder provider was invented for an unattributed request');
  assert.equal(record.connectionId, undefined);
  const { totals } = await store.summary();
  assert.equal(totals.requests, 1, 'an unattributed request still happened and must still be counted');
  assert.equal(totals.cancelled, 1);
});

test('a query by provider does not match unattributed records', async () => {
  const store = new InMemoryUsageStore();
  await store.record(entry({ providerId: 'anthropic', connectionId: 'c1' }));
  await store.record({ at: '2026-10-04T10:00:00.000Z', model: 'm', outcome: 'cancelled', attempts: 0, latencyMs: 5 });
  assert.equal((await store.list({ providerId: 'anthropic' })).length, 1);
  assert.equal((await store.list()).length, 2, 'an unfiltered query still sees both');
});

test('summarizeUsage treats a non-array as no records rather than throwing', () => {
  const totals = summarizeUsage([]);
  assert.equal(totals.requests, 0);
  assert.equal(totals.tokensUnmeasured, true, 'an empty set of records is unmeasured, not zero-measured');
});
