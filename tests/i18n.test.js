import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src/i18n/index.tsx'), 'utf8');

test('every English message has an Arabic counterpart, and RTL is derived from the locale', () => {
  const enBlock = source.slice(source.indexOf('const en = {'), source.indexOf('} as const;'));
  const enKeys = [...enBlock.matchAll(/^  '([^']+)':/gm)].map((match) => match[1]);
  const arBlock = source.slice(source.indexOf('const ar:'), source.indexOf('export const catalogues'));
  const arKeys = [...arBlock.matchAll(/^  '([^']+)':/gm)].map((match) => match[1]);
  assert.ok(enKeys.length >= 10);
  assert.deepEqual(arKeys.sort(), enKeys.sort(), 'the Arabic catalogue is missing a message');
  assert.match(source, /locale === 'ar' \? 'rtl' : 'ltr'/);
});
