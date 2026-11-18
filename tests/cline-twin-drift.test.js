import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The two Cline implementations are vendored twins: `ClineAdapter` in `cline/adapter/index.ts` and the copy
 * `ClinePassAdapter` inherits in `clinepass/lib/cline.ts`. A fix applied to one and not the other is silent —
 * both adapters work, but only one has the fix — which is why AGENTS.md names the drift as a boundary. Only the
 * version constant is checked elsewhere, so this test compares the implementations.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = join(ROOT, 'Kernel/SDK/cline/adapter/index.ts');
const B = join(ROOT, 'Kernel/SDK/clinepass/lib/cline.ts');

/** Comments and the vendored import path differ deliberately; the executable statements must match. */
function implementation(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/from '\.\.\/lib\//g, "from './")
    // The ClinePass copy re-exports its vendored wire types for its own package; the Cline copy does not.
    .replace(/export \* from '\.\/openai-compatible\.js';\s*$/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

test('the vendored Cline implementations have not drifted', () => {
  const left = implementation(A);
  const right = implementation(B);
  assert.equal(left, right, `the two Cline copies differ — see ${A} and ${B}`);
});
