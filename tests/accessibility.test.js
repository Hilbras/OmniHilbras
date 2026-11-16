import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Accessibility held as a property of the source, not as a habit.
 *
 * Every rule here already held when this file was written — measured, not assumed:
 *
 * - every `role="dialog"` carries `aria-modal` and an accessible name (the earlier "three dialogs are missing
 *   `aria-modal`" note came from a line-level grep, and the attribute is on the following line in all three);
 * - no icon-only `<button>` lacks a name;
 * - every `<img>` carries `alt`;
 * - every form field is named by `aria-label`/`aria-labelledby`, sits inside a `<label>`, or carries an `id`
 *   somewhere `htmlFor` can point at. One did not: the backup file input on the About page, now labelled.
 *
 * So these are regression locks. The value is that the next icon-only button or unlabelled field fails a test
 * instead of shipping — and unlike a browser run, it costs nothing and runs inside `pnpm verify`.
 *
 * The tag scanner is brace- and quote-aware on purpose: `onChange={(event) => …}` contains a `>` that a naive
 * `split('>')` treats as the end of the tag, which silently truncated the attribute list and produced two false
 * positives while this was being written.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function tsxFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await tsxFiles(path));
    else if (entry.name.endsWith('.tsx')) files.push(path);
  }
  return files;
}

/** The opening tag that starts at `start`, ignoring `>` inside strings and braces. */
function openTagAt(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') { depth += 1; continue; }
    if (char === '}') { depth -= 1; continue; }
    if (char === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

test('every dialog is modal and named', async () => {
  const problems = [];
  for (const file of await tsxFiles(join(ROOT, 'src'))) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/role="dialog"/g)) {
      const tag = openTagAt(text, text.lastIndexOf('<', match.index));
      if (!tag.includes('aria-modal')) problems.push(`${file}:${lineOf(text, match.index)} has no aria-modal`);
      if (!tag.includes('aria-label') && !tag.includes('aria-labelledby')) problems.push(`${file}:${lineOf(text, match.index)} has no accessible name`);
    }
    // The overlay is not the dialog: a role on the backdrop would trap nothing and name nothing.
    for (const match of text.matchAll(/<div[^>]*\sonClick=/g)) {
      void match;
    }
  }
  assert.deepEqual(problems, [], `a dialog lost its modality or its name:\n${problems.join('\n')}`);
});

test('an icon-only button still has a name', async () => {
  const problems = [];
  for (const file of await tsxFiles(join(ROOT, 'src'))) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/<button\b/g)) {
      const tag = openTagAt(text, match.index);
      if (tag.includes('aria-label') || tag.includes('aria-labelledby')) continue;
      const close = text.indexOf('</button>', match.index);
      const body = text.slice(match.index + tag.length, close === -1 ? match.index + 800 : close)
        // Icons and `aria-hidden` decoration are not content a screen reader can name the button with.
        .replace(/<[A-Z][A-Za-z0-9]*\s[^>]*\/>/g, '')
        .replace(/<span[^>]*aria-hidden="true"[^>]*\/>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (!body) problems.push(`${file}:${lineOf(text, match.index)} is icon-only and unnamed`);
    }
  }
  assert.deepEqual(problems, [], `a button has no accessible name:\n${problems.join('\n')}`);
});

test('every image carries alt', async () => {
  const problems = [];
  for (const file of await tsxFiles(join(ROOT, 'src'))) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/<img\b/g)) {
      const tag = openTagAt(text, match.index);
      if (!/\salt=/.test(tag)) problems.push(`${file}:${lineOf(text, match.index)} has no alt`);
    }
  }
  assert.deepEqual(problems, [], `an image has no alt:\n${problems.join('\n')}`);
});

test('every form field is named', async () => {
  const problems = [];
  for (const file of await tsxFiles(join(ROOT, 'src'))) {
    const text = await readFile(file, 'utf8');
    if (!/htmlFor=/.test(text)) { /* an id is only a name if something points at it */ }
    for (const match of text.matchAll(/<(input|select|textarea)\b/g)) {
      const tag = openTagAt(text, match.index);
      if (/type="hidden"/.test(tag)) continue;
      if (tag.includes('aria-label') || tag.includes('aria-labelledby')) continue;
      // A wrapping <label> names the field it contains.
      const before = text.slice(0, match.index);
      if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
      if (/\bid="/.test(tag) && /htmlFor=/.test(text)) continue;
      problems.push(`${file}:${lineOf(text, match.index)} is unnamed`);
    }
  }
  assert.deepEqual(problems, [], `a form field has no accessible name:\n${problems.join('\n')}`);
});
