import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The generated 9router provider catalog.
 *
 * This document is derived from another tree, so the only property that makes it worth reading is
 * that it is **either current or absent**. Three things are asserted for that, and each one exists
 * because its absence produced a confidently wrong file rather than an obviously broken one:
 *
 * 1. **it is current** — regenerating must produce byte-identical output (`--check` exits 0);
 * 2. **its numbers are counted, not typed** — the header totals must equal what the body contains,
 *    so a partially-generated file cannot pass;
 * 3. **its values are whole values** — every provider website must be a complete URL, which is the
 *    exact corruption a naive comment-stripper caused (see below).
 *
 * ## The bug this file exists because of
 *
 * Stripping line comments naively (slash-slash up to end of line) treats the pair inside
 * `https:` as the start of a comment. Every `website:` line was cut at `https:`, the capture
 * then ran across the following lines, and **118 of 124 entries rendered a site link cut off
 * mid-URL** — in a document whose entire purpose is to be read. Nothing looked broken:
 * 2002 lines, well-formed tables, and correct counts.
 *
 * That is why the URL assertion is here and not merely a rendering detail. It is the one field whose
 * corruption is invisible to a line count, a table-shape check, or a count assertion.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'build-9router-catalog.mjs');
const CATALOG = join(ROOT, 'docs', 'architecture', '9router-provider-catalog.md');
const REGISTRY = '/home/gin/work/9router/open-sse/providers/registry';

// The catalog documents a tree that is not ours. Skipped, not failed, when it is absent — a checkout
// of this repository does not contain it, and CI must stay green there.
const sourceTreePresent = existsSync(REGISTRY);

test('the catalog is either absent or regenerable, never stale', { skip: !sourceTreePresent }, () => {
  assert.ok(existsSync(SCRIPT), 'the generator script must be committed alongside the document');
  assert.ok(existsSync(CATALOG), 'the catalog must be committed');
  // Byte-identical regeneration. This is the assertion that makes the document trustworthy: it is
  // derived, so it is either current or wrong, and there is no third state.
  execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, stdio: 'pipe' });
});

test('the header counts match what the body actually contains', { skip: !sourceTreePresent }, () => {
  const doc = readFileSync(CATALOG, 'utf8');
  const claimed = (label) => {
    const row = new RegExp(`^\\| ${label} \\| (\\d+) \\|$`, 'm').exec(doc);
    assert.ok(row, `the summary table must state "${label}"`);
    return Number(row[1]);
  };

  const headings = (doc.match(/^#### `/gm) ?? []).length;
  const dynamicRows = (doc.slice(doc.indexOf('## Entries with no static model list')).match(/^\| `/gm) ?? []).length;
  const entries = claimed('Registry entries');
  const models = claimed('Models declared in the registry');

  assert.equal(headings, entries, 'one heading per registry entry');
  assert.equal(claimed('Entries with a static model list') + claimed('Entries that resolve models at runtime'), entries);
  assert.equal(claimed('Entries that resolve models at runtime'), dynamicRows, 'the two runtime-resolved counts must agree');

  // Every model row in the body, which is the number a reader would count by hand.
  const body = doc.slice(doc.indexOf('## Providers'), doc.indexOf('## Entries with no static model list'));
  // Any character may start a model id — Cloudflare's are `@cf/meta/…` — so the pattern is "a row
  // beginning with a backticked cell", not an alphanumeric assumption. My first version used
  // `[a-zA-Z0-9]` and reported 1031 of 1055 models present, which read as 24 missing rows and was a
  // fault in the guard, not in the document.
  const rows = (body.match(/^\| `[^`]+` \|/gm) ?? []).length;
  assert.equal(rows, models, `the body lists ${rows} model rows but the header claims ${models}`);

  // A generator that produced an empty document would satisfy several of the checks above.
  assert.ok(entries > 0 && models > 0, 'a catalog with no entries or no models proves nothing');
});

test('every provider website is a complete URL, not a truncated fragment', { skip: !sourceTreePresent }, () => {
  const doc = readFileSync(CATALOG, 'utf8');
  const links = [...doc.matchAll(/\[site\]\(([^)]*)\)/g)].map((match) => match[1]);
  const broken = links.filter((url) => !/^https?:\/\/[^\s)]+$/.test(url));
  assert.deepEqual(
    broken,
    [],
    `${broken.length} provider links are not whole URLs — the first is ${JSON.stringify(broken[0])}. ` +
      'This is the signature of the `//` inside `https://` being stripped as a line comment.',
  );
  assert.ok(links.length > 0, 'the document should link at least one provider site');
});

test('no cell leaks raw source across a line boundary', { skip: !sourceTreePresent }, () => {
  // The general property behind the previous test: a value pulled out of a source file must not
  // contain a newline, because a value containing one was captured across lines.
  const doc = readFileSync(CATALOG, 'utf8');
  const badRows = doc
    .split('\n')
    .filter((line) => /\| [^|]*\b(display|category|serviceKinds|baseUrl):/.test(line));
  assert.deepEqual(badRows, [], `source fragments leaked into the table: ${badRows[0]?.slice(0, 80)}`);
});