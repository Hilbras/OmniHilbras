import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ConnectionMetadataLimitError, LocalConnectionStore, resolveMaxMetadataBytes } from '../dist/src/core/connections.js';
import { toErrorEnvelope } from '../dist/src/core/http.js';
import { ProviderError } from '../dist/src/core/provider-error.js';

/**
 * The metadata ceiling, and the vault that ran out of it.
 *
 * A vault measured on this machine held **262,137 bytes against a 262,144-byte limit** — full to seven
 * bytes — and adding one more provider was impossible. The file was written pretty-printed, so about
 * 42% of that budget was indentation, and the ceiling was sized for a handful of providers rather than
 * a vault of hundreds of connections.
 */

const withEnv = async (t, value) => {
  const previous = process.env.OMNIHILBRAS_MAX_METADATA_BYTES;
  if (value === undefined) delete process.env.OMNIHILBRAS_MAX_METADATA_BYTES;
  else process.env.OMNIHILBRAS_MAX_METADATA_BYTES = value;
  t.after(() => {
    if (previous === undefined) delete process.env.OMNIHILBRAS_MAX_METADATA_BYTES;
    else process.env.OMNIHILBRAS_MAX_METADATA_BYTES = previous;
  });
};

const tempStore = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'metadata-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new LocalConnectionStore({ directory }) };
};

const connection = (i) => ({
  id: `p${i}`,
  providerId: `p${i}`,
  name: `P${i}`,
  endpoint: 'https://example.com/v1',
  priority: 1,
  proxyPool: 'none',
});

test('the ceiling leaves room for a full vault, and moves without a release', () => {
  assert.equal(resolveMaxMetadataBytes({}), 4 * 1024 * 1024);
  assert.ok(resolveMaxMetadataBytes({}) > 256 * 1024, 'the old ceiling is the one a real vault filled');
  assert.equal(resolveMaxMetadataBytes({ OMNIHILBRAS_MAX_METADATA_BYTES: '1024' }), 1024);
  // A bound that cannot be parsed is not a reason to refuse to open the vault.
  for (const bad of ['0', '-1', 'lots', ' ', '1.5']) {
    assert.equal(resolveMaxMetadataBytes({ OMNIHILBRAS_MAX_METADATA_BYTES: bad }), 4 * 1024 * 1024, bad);
  }
});

test('the metadata file is written compact, and still loads', async (t) => {
  const { directory, store } = await tempStore(t);
  await store.save(connection(0), { type: 'api-key', value: 'k0' });

  const text = await readFile(join(directory, 'connections.json'), 'utf8');
  assert.equal(text.includes('\n  '), false, 'indentation is not what the budget should be spent on');
  assert.equal(text.split('\n').length, 2, 'one line of JSON and its newline');
  assert.equal(JSON.parse(text).connections.length, 1);

  // A file written before this change — pretty-printed — is still read.
  const pretty = JSON.stringify(JSON.parse(text), null, 2) + '\n';
  await writeFile(join(directory, 'connections.json'), pretty);
  const reopened = new LocalConnectionStore({ directory });
  assert.equal((await reopened.list()).length, 1);
});

test('a full metadata file refuses the save, keeps the vault intact, and says what to do', async (t) => {
  // Small enough that a handful of ordinary connections fill it, so the test fills the cap the way a
  // real vault does: by accumulating connections, not by hiding a 4,000-character name in one record.
  await withEnv(t, '1500');
  const { directory, store } = await tempStore(t);
  await store.save(connection(0), { type: 'api-key', value: 'k0' });

  let failure = null;
  let saved = 1;
  for (let i = 1; i <= 200 && !failure; i += 1) {
    failure = await store.save(connection(i), { type: 'api-key', value: `k${i}` }).then(() => null, (error) => error);
    if (!failure) saved += 1;
  }

  assert.ok(failure, 'a vault that fills its metadata budget must eventually refuse a save');
  assert.equal(failure.name, 'ConnectionMetadataLimitError');
  assert.match(failure.message, /exceeds its size limit/, 'the message names the limit, in the words the store already used');
  assert.match(failure.message, /\d+ KiB of the \d+ KiB allowed/, 'and states both the size and the ceiling');
  assert.match(failure.message, /OMNIHILBRAS_MAX_METADATA_BYTES/, 'and the way out');

  // The refused save left nothing behind: the vault on disk holds exactly what was accepted.
  const onDisk = JSON.parse(await readFile(join(directory, 'connections.json'), 'utf8'));
  assert.equal(onDisk.connections.length, saved);
  assert.equal(onDisk.connections.some((entry) => entry.id === `p${saved}`), false);
});

test('the refusal reaches the caller as its reason, not as a generic sentence', async (t) => {
  await withEnv(t, '1500');
  const { store } = await tempStore(t);
  await store.save(connection(0), { type: 'api-key', value: 'k0' });

  let failure = null;
  for (let i = 1; i <= 200 && !failure; i += 1) {
    failure = await store.save(connection(i), { type: 'api-key', value: `k${i}` }).then(() => null, (error) => error);
  }
  assert.ok(failure instanceof ConnectionMetadataLimitError, `expected the metadata refusal, got ${failure?.name}`);

  // The store alone is not what a caller talks to: `connection-manager` wraps it, and the wrapper is
  // where the reason was being dropped — v3.43.1 made it forward `publicMessage` for exactly this.
  const wrapper = readFileSync(new URL('../dist/src/core/connection-manager.js', import.meta.url), 'utf8');
  assert.match(wrapper, /ConnectionMetadataLimitError/, 'the wrapper must recognise it');
  assert.match(wrapper, /publicMessage: error\.message/, 'and must not discard its message');

  // And the envelope prefers the error's own message when it has one — which is exactly what the
  // wrapper's `publicMessage` produces. A raw store error is not a `ProviderError`, so on its own it
  // would be reported as "The gateway encountered an unexpected error."; that is why the wrapper has to
  // carry the reason across, and the two assertions above are what keep it doing so.
  assert.equal(toErrorEnvelope(failure).error.message, 'The gateway encountered an unexpected error.');
  const asProviderError = new ProviderError('INVALID_REQUEST', failure.message, { publicMessage: failure.message });
  assert.equal(toErrorEnvelope(asProviderError).error.message, failure.message);
});
