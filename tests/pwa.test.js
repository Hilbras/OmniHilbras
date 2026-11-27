import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('the shell is installable and offline, and never caches the API', () => {
  assert.ok(existsSync(join(ROOT, 'public/manifest.webmanifest')));
  assert.ok(existsSync(join(ROOT, 'public/offline.html')));
  const worker = read('public/sw.js');
  assert.match(worker, /url\.pathname\.startsWith\('\/v1'\)/, 'the worker does not exclude the API');
  assert.match(worker, /caches\.match\('\/dashboard'\)/);
  assert.match(read('index.html'), /rel="manifest"/);
  assert.match(read('src/main.tsx'), /serviceWorker\.register\('\/sw\.js'\)/);
});
