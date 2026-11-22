import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** Source guards for two provider-page display decisions that are easy to undo in a markup cleanup. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(root, 'src', 'pages', 'ProviderDetailPage.tsx'), 'utf8');

test('a model row puts catalog facts under the id, not beside it', () => {
  const idLine = page.indexOf('{prefix}/{model}</p>');
  const badgesLine = page.indexOf('badges.map((badge)');
  assert.ok(idLine >= 0 && badgesLine > idLine, 'the facts must come after the id in the rendered row');
  const between = page.slice(idLine, badgesLine);
  assert.match(between, /<\/div>/, 'the id line closes before the facts begin');
  assert.match(between, /className="mt-1 flex flex-wrap/, 'the facts are a wrapped second line');
  assert.doesNotMatch(between, /<code /, 'the id is not repeated under itself');
  assert.match(page, /\$\{input\}\/M in/, 'prices are labelled per million tokens');
  assert.match(page, /\$\{context\} ctx/, 'context is still shown');
});

test('an account card shows at most five rows and scrolls for the rest', () => {
  const scroll = page.indexOf('data-account-scroll={connections.length > 5');
  assert.ok(scroll > 0, 'the detail card has the same scroll affordance as the accounts panel');
  const wrapper = page.slice(scroll - 400, scroll + 600);
  assert.match(wrapper, /max-h-\[[0-9]+rem\]/, 'a height cap keeps five rows visible');
  assert.match(wrapper, /overflow-y-auto/, 'and the rest are reachable by scrolling');
  assert.match(wrapper, /connections\.map\(/, 'the cap wraps the account rows, not some other list');
});
