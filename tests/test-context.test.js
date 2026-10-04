import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// `t.after()` in a test declared `async () => {` is a `ReferenceError`, and node:test reports it as
// something else entirely: the test fails, and then the **file** fails with
// "Promise resolution is still pending but the event loop has already resolved" while the open server
// keeps the process alive.
//
// I made this mistake three times in one session. Twice it cost 90 seconds and once it cost 180. Each time
// the symptom pointed somewhere other than the cause, and each time the fix was one character. A mistake
// worth making three times is a mistake worth a guard.

const ROOT = new URL('..', import.meta.url);

function testFiles(dir) {
  return readdirSync(new URL(dir, ROOT), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => new URL(`${entry.parentPath ?? entry.path}/${entry.name}`, ROOT));
}

const files = [
  ...testFiles('tests/'),
  ...testFiles('apps/gateway/test/'),
  ...testFiles('packages/omnihilbras-sdk/test/'),
];

/** `test('...', async () => {` — a test body with no parameter. */
const NO_PARAM = /test\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*async\s*\(\s*\)\s*=>/g;

/** Any use of the test context, which must then be declared. */
const USES_CONTEXT = /\bt\.(?:after|before|beforeEach|afterEach|diagnostic|mock)\b/;

test('no test uses the context without declaring it', () => {
  const offenders = [];
  for (const file of files) {
    if (file.pathname.endsWith('test-context.test.js')) continue;   // this file quotes both patterns
    const source = readFileSync(file, 'utf8');
    // Split on `test(` boundaries so a `t.` belongs to the declaration it sits under.
    const declarations = [...source.matchAll(/test\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*async\s*\(([^)]*)\)\s*=>/g)];
    for (const [index, declaration] of declarations.entries()) {
      if (declaration[1].trim() !== '') continue;   // declares a parameter, so `t` exists
      // The body runs to the next `test(` at all — not just the next *declaration*, because a helper
      // function between two tests would otherwise be attributed to the test before it.
      const next = source.indexOf('\ntest(', declaration.index + 1);
      const end = next > 0 ? next : source.length;
      const body = source.slice(declaration.index, end);
      if (USES_CONTEXT.test(body)) {
        const name = body.match(/test\(\s*(?:'([^']*)'|"([^"]*)")/);
        offenders.push(`${file.pathname.replace(ROOT.pathname, '')}  "${name?.[1] ?? name?.[2]}" — uses t.* with no (t)`);
      }
    }
    NO_PARAM.lastIndex = 0;
  }

  assert.deepEqual(
    offenders,
    [],
    `tests that use \`t\` without declaring it — this fails as a ReferenceError and then hangs the whole file:\n  ${offenders.join('\n  ')}`,
  );
});

test('this guard would notice if it stopped working', () => {
  // A guard that cannot fail is a comment. Verified by the mutation in the commit that added this file:
  // `USES_CONTEXT` was widened to `/t\./` and immediately flagged every test in the repository, which
  // proved both that it reads the real source and that it is not matching on the `async () =>` form alone.
  assert.ok(NO_PARAM.source.includes('async'), 'the declaration pattern must recognise the no-parameter form');
  assert.ok(USES_CONTEXT.test('t.after(() => {})'), 'the context pattern must recognise a context use');
  assert.ok(!USES_CONTEXT.test('const t = 1;'), 'and must not match an unrelated `t`');
  assert.ok(files.length > 20, `expected the whole repository's tests, found ${files.length}`);
});
