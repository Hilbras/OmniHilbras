import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github', 'workflows', 'verify.yml'), 'utf8');

test('CI runs the canonical verify command, not a subset of its steps', () => {
  assert.match(workflow, /run:\s*pnpm verify\b/, 'the workflow must run `pnpm verify`');
});

test('CI does not re-list the individual checks that verify already covers', () => {
  assert.doesNotMatch(workflow, /run:\s*pnpm (typecheck|test|build|version:check|analyze:check|test:brand)\b/,
    'a separate step would let CI drift from the local command');
});
