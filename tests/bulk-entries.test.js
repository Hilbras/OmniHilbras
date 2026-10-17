import assert from 'node:assert/strict';
import test from 'node:test';
import { bulkEntryName, parseBulkEntries } from '../src/lib/bulkEntries.ts';

/**
 * The Bulk Add parser, **called** rather than read.
 *
 * This exists because the property it states was silently false for the whole life of the feature, and no
 * test could have noticed: the parsing lived inline in `AddProviderModal.tsx`, a `.tsx` that imports React
 * and renders a portal, so nothing could load it. Extracting it to `src/lib/` is the same move
 * `providerOptions` and `routingVerdict` needed — read that file's own comment for the lesson, which this is
 * the third instance of.
 *
 * The defect: the inline version parsed each line for a **name** and discarded the rest.
 *
 * ```ts
 * const entryName = separator > 0 ? entry.slice(0, separator).trim() : '';   // and the key was never read
 * ```
 *
 * Every entry it produced carried `hasKey: true` — a claim that a key existed — while the save path it was
 * handed to needs the key itself. So the bulk tab could not save anything, and the one page whose bulk
 * handler was already honest could only report one failure per line.
 */

test('the key from each line survives parsing, which is the whole point', () => {
  assert.deepEqual(parseBulkEntries('work|sk-abc123'), [{ name: 'work', key: 'sk-abc123' }]);
});

test('a bare key is an entry with no name, not a discarded line', () => {
  assert.deepEqual(parseBulkEntries('sk-abc123'), [{ name: '', key: 'sk-abc123' }]);
});

test('every line becomes its own entry, with its own key', () => {
  const entries = parseBulkEntries('one|sk-1\n\n  two|sk-2  \r\nsk-3\n');
  assert.deepEqual(entries, [
    { name: 'one', key: 'sk-1' },
    { name: 'two', key: 'sk-2' },
    { name: '', key: 'sk-3' },
  ]);
});

test('no entry can carry an empty key', () => {
  // `name|` is refused rather than saved as an empty password. An empty string is what the gateway refuses
  // outright (`parseApiKey` → `apiKey must be a non-empty safe string.`), so producing one would turn a
  // blank line the user left behind into a request that fails for a reason they cannot see.
  for (const entry of parseBulkEntries('a|\nb|sk-2\n|\n')) {
    assert.ok(entry.key.length > 0, `an empty key reached the batch: ${JSON.stringify(entry)}`);
  }
  assert.deepEqual(parseBulkEntries('a|\n|\n'), []);
});

test('a key containing the separator keeps the rest of itself', () => {
  // Only the *first* separator splits, so a key with a pipe in it is not truncated into a wrong key — the
  // worst possible outcome here, because it would be saved and look like it worked.
  assert.deepEqual(parseBulkEntries('name|sk-a|sk-b'), [{ name: 'name', key: 'sk-a|sk-b' }]);
});

test('an unnamed entry is named from the dialog, and never left blank', () => {
  // A connection with an empty name is one the user cannot tell apart from another in the list.
  assert.equal(bulkEntryName({ name: '', key: 'k' }, 'My provider', 'OpenAI', 0), 'My provider');
  assert.equal(bulkEntryName({ name: '', key: 'k' }, '   ', 'OpenAI', 2), 'OpenAI 3');
  assert.equal(bulkEntryName({ name: 'work', key: 'k' }, 'ignored', 'OpenAI', 0), 'work');
});