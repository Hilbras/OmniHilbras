import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROVIDER_REGISTRY } from '../Kernel/Tools/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cards = () => [...readFileSync(join(ROOT, 'src/data/providers.ts'), 'utf8').matchAll(/^\s{4}id: '([^']+)'/gm)].map((match) => match[1]);

test('every catalog provider id owns a registry row, and every row names a card', () => {
  const ids = cards();
  assert.ok(ids.length > 50, `no cards parsed (${ids.length}); the guard would pass vacuously`);
  const rows = new Set(Object.keys(PROVIDER_REGISTRY));
  const missing = ids.filter((id) => !rows.has(id));
  assert.deepEqual(missing, [], `provider ids with no own config: ${missing.join(', ')}`);
  const ghosts = [...rows].filter((id) => !ids.includes(id));
  assert.deepEqual(ghosts, [], `registry rows with no catalog card: ${ghosts.join(', ')}`);
});

test('every registry row owns its base URL and wire format', () => {
  for (const [id, row] of Object.entries(PROVIDER_REGISTRY)) {
    assert.equal(row.id, id, `${id}'s row names a different id`);
    assert.match(row.baseUrl, /^https?:\/\//, `${id} has no base URL`);
    assert.ok(row.formats.length > 0, `${id} has no wire format`);
    if (row.formats.includes('web')) assert.equal(row.auth, 'web', `${id} is a web session with a non-web auth mode`);
  }
});
