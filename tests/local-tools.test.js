import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('the local tool surface has no shell, write or network capability', () => {
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const catalog = strip(read('Kernel/Tools/src/localTools.ts'));
  const executor = strip(read('Kernel/API/src/core/local-tool-executor.ts'));
  for (const source of [catalog, executor]) {
    assert.doesNotMatch(source, /\bbash\b/, 'a shell tool is declared');
    assert.doesNotMatch(source, /child_process|\bspawn\(|writeFile|unlink|fetch\(|https?\.request/, 'a command, write or network call reached the local tool layer');
  }
  assert.match(executor, /OMNIHILBRAS_LOCAL_TOOLS/, 'the layer is not gated by the opt-in flag');
  assert.match(executor, /realpathSync/, 'paths are not resolved against symlinks');
});

test('local tools are only added to the non-streaming chat path', () => {
  const service = read('Kernel/API/src/core/service.ts');
  assert.match(service, /applyToolContract\(providerId, request, true, connectionId\)/, 'chat does not request local tools');
  assert.match(service, /applyToolContract\(providerId, request, false, connectionId\)/, 'streaming does not explicitly decline local tools');
  assert.doesNotMatch(service, /applyToolContract\(providerId, request, true\)/, 'a stale two-argument call remains');
});

test('a local tool round restores caller names exactly like the direct chat path', () => {
  // The direct path passed `contracted.renames` to `validatedToolResponse`; the local-tool loop used
  // to omit it. A provider folding `Read` to `read` then returned `read`, and an agent that declared
  // `Read` saw a call it could not recognise — the same drift as the stream path before 3.90.5.
  const service = read('Kernel/API/src/core/service.ts');
  const start = service.indexOf('private async runLocalToolRounds');
  const end = service.indexOf('async chat(', start);
  assert.ok(start >= 0 && end > start, 'the local tool loop could not be located');
  const body = service.slice(start, end);
  assert.match(body, /validatedToolResponse\([\s\S]*contracted\.renames/, 'a local tool round drops the caller name map');
});
