import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { ConnectionLimitError, LocalConnectionStore, resolveMaxConnections } from '../dist/src/core/connections.js';

/**
 * The connection limit, and the reason it exists as a test.
 *
 * A vault measured on this machine held **113** connections against a flat limit of 100, so every save
 * past it was refused — and refused with "The request is invalid.", because the store threw a plain
 * `Error` and the wrapper around it asked for a public message it never supplied. The person adding a
 * provider had nothing to act on and no way to know the vault was simply full.
 */

async function tempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'connection-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new LocalConnectionStore({ directory: dir });
}

test('the bound is generous enough for several accounts per provider, and movable', () => {
  // The catalogue is 56 cards. Two accounts on a handful of providers crosses a hundred without anyone
  // doing anything unusual, which is how a vault reached 113 and stopped accepting connections.
  assert.equal(resolveMaxConnections({}), 250);
  assert.equal(resolveMaxConnections({ OMNIHILBRAS_MAX_CONNECTIONS: '5' }), 5);
  assert.equal(resolveMaxConnections({ OMNIHILBRAS_MAX_CONNECTIONS: '0' }), 250, 'zero is not a vault of no connections');
  assert.equal(resolveMaxConnections({ OMNIHILBRAS_MAX_CONNECTIONS: '-1' }), 250);
  assert.equal(resolveMaxConnections({ OMNIHILBRAS_MAX_CONNECTIONS: 'lots' }), 250);
  assert.ok(resolveMaxConnections({}) > 100, 'the old bound is the one that surprised a real vault');
});

test('the refusal is typed and says what to do about it', async (t) => {
  const previous = process.env.OMNIHILBRAS_MAX_CONNECTIONS;
  process.env.OMNIHILBRAS_MAX_CONNECTIONS = '2';
  t.after(() => {
    if (previous === undefined) delete process.env.OMNIHILBRAS_MAX_CONNECTIONS;
    else process.env.OMNIHILBRAS_MAX_CONNECTIONS = previous;
  });

  const store = await tempStore(t);
  const save = (i) => store.save(
    { id: `p${i}`, providerId: `p${i}`, name: `P${i}`, endpoint: 'https://example.com/v1', priority: 1, proxyPool: 'none' },
    { type: 'api-key', value: `key-${i}` },
  );
  await save(0);
  await save(1);

  await assert.rejects(() => save(2), (error) => {
    assert.equal(error.name, 'ConnectionLimitError', 'the refusal must be identifiable');
    assert.match(error.message, /connection limit/i);
    assert.match(error.message, /OMNIHILBRAS_MAX_CONNECTIONS/, 'and it must name the way out');
    return true;
  });

  // Replacing an existing connection is not adding one, so it still works at the bound.
  await store.save({ id: 'p0', providerId: 'p0', name: 'Renamed', endpoint: 'https://example.com/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-new' });
  const stored = (await store.list()).find((connection) => connection.id === 'p0');
  assert.equal(stored?.name, 'Renamed');
});

test('the error the caller sees is the reason, not a generic sentence', () => {
  // `toErrorEnvelope` prefers the error's own public message; the wrapper around the store must supply
  // one, or the message above is thrown away and replaced by "The request is invalid."
  const source = readFileSync(new URL('../dist/src/core/connection-manager.js', import.meta.url), 'utf8');
  assert.match(source, /ConnectionLimitError/, 'the wrapper must know the limit error');
  assert.match(source, /publicMessage: error\.message/, 'and must pass its reason through');
});

test('no INVALID_REQUEST is raised without a message the caller can act on', () => {
  /**
   * The class of defect, not the instance: the generic sentence exists as a *fallback*, and it becomes
   * the answer whenever our own code raises INVALID_REQUEST without saying why. This scans the sources
   * for that shape and refuses to let a new one in.
   */
  const roots = ['src/core', 'src/routes'];
  const offenders = [];
  for (const root of roots) {
    const dir = new URL(`../${root}/`, import.meta.url);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      // Comments quote the very shape this test looks for — one does, to explain the defect — so the
      // scan reads code with the prose removed.
      const text = readFileSync(new URL(name, dir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
      if (!text.includes('INVALID_REQUEST')) continue;
      for (const match of text.matchAll(/ProviderError\(\s*'INVALID_REQUEST'([\s\S]{0,400}?)\);/g)) {
        if (!match[1].includes('publicMessage')) offenders.push(`${root}/${name}: ${match[0].replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'these raise INVALID_REQUEST with nothing to act on');
});
