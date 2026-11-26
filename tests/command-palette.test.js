import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The V4 command palette is a real listbox, not a text box that navigates.
 *
 * These assertions are source-level because the alternative is a browser per claim. They hold the
 * properties that make the palette usable without a mouse: the shortcut, the dialog semantics, the
 * active-descendant wiring, focus restoration, and the fact that its destinations are the same
 * array the sidebar renders rather than a second list that can drift.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const palette = read('src/components/CommandPalette.tsx');
const shell = read('src/components/DashboardShell.tsx');

test('Cmd/Ctrl+K opens the palette from anywhere in the shell', () => {
  assert.match(shell, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(shell, /event\.key\.toLowerCase\(\) === 'k'/);
  assert.match(shell, /setPaletteOpen\(\(value\) => !value\)/);
  assert.match(shell, /window\.addEventListener\('keydown', onShortcut\)/);
});

test('the palette is a dialog with a combobox and a listbox', () => {
  assert.match(palette, /role="dialog"/);
  assert.match(palette, /aria-modal="true"/);
  assert.match(palette, /role="combobox"/);
  assert.match(palette, /role="listbox"/);
  assert.match(palette, /aria-activedescendant=/);
  assert.match(palette, /role="option"/);
  assert.match(palette, /aria-selected=/);
});

test('keyboard movement, Enter and Escape are handled', () => {
  assert.match(palette, /event\.key === 'ArrowDown'/);
  assert.match(palette, /event\.key === 'ArrowUp'/);
  assert.match(palette, /event\.key === 'Enter'/);
  assert.match(palette, /event\.key === 'Escape'/);
  assert.match(palette, /choose\(filtered\[active\]\)/);
});

test('focus returns to the element that opened the palette', () => {
  assert.match(palette, /restoreRef\.current = document\.activeElement/);
  assert.match(palette, /restoreRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(palette, /setTimeout/, 'focus must not depend on a timer');
});

test('the destinations are the sidebar arrays, not a second list', () => {
  assert.match(shell, /items=\{\[\.\.\.primaryItems, \.\.\.insightItems\]/);
  assert.doesNotMatch(palette, /to: '\//, 'the palette hard-codes a route the shell does not own');
  assert.match(palette, /items: readonly CommandPaletteItem\[\]/);
});

test('an empty result says so rather than showing a blank dialog', () => {
  assert.match(palette, /No destination matches/);
});