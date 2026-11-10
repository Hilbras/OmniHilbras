import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryCcrStore,
  MIN_COMPRESS_SIZE,
  RAW_CAP,
  autoDetectFilter,
  compressMessages,
  compressRtk,
  retrieve,
} from '../dist/index.js';

/**
 * Specialized tool-output filters ported from the old RTK implementation.
 *
 * Every fixture must show four things: the rewrite is smaller, the important lines survive, the
 * reference caps hold, and the original is retrievable from the CCR store. Autodetect is tested both
 * by content and by an explicit tool name, because the caller often knows the tool.
 */

const diffFixture = Array.from({ length: 12 }, (_, index) => `diff --git a/src/file${index}.ts b/src/file${index}.ts
index 1111111..2222222 100644
--- a/src/file${index}.ts
+++ b/src/file${index}.ts
@@ -1,3 +1,4 @@
 context ${index}
+IMPORTANT_ADDED_${index}
 context after ${index}`).join('\n');

const hugeHunk = [
  'diff --git a/big b/big',
  '--- a/big',
  '+++ b/big',
  '@@ -0,0 +1,150 @@',
  ...Array.from({ length: 150 }, (_, index) => `+added line ${index}`),
  ' context tail',
].join('\n');

const statusFixture = [
  'On branch main',
  ...Array.from({ length: 30 }, (_, index) => `M  src/staged${index}.ts`),
  ...Array.from({ length: 30 }, (_, index) => ` M src/modified${index}.ts`),
  ...Array.from({ length: 30 }, (_, index) => `?? src/untracked${index}.ts`),
].join('\n');

const logFixture = Array.from({ length: 80 }, (_, index) => {
  const sha = index.toString(16).padStart(40, '0');
  return `commit ${sha}
Author: A <a${index}@example.com>
Date:   Mon Nov 10 12:00:00 2026 +0000

    subject for commit ${index}

    body line one for ${index} ${'padding '.repeat(8)}
    body line two for ${index} ${'padding '.repeat(8)}`;
}).join('\n\n');

const grepFixture = Array.from({ length: 30 }, (_, file) => Array.from(
  { length: 15 },
  (_, match) => `src/module${file}.ts:${10 + match}:MATCH_${file}_${match} ${'content '.repeat(6)}`,
).join('\n')).join('\n');

const findFixture = Array.from({ length: 25 }, (_, dir) => Array.from(
  { length: 12 },
  (_, file) => `src/pkg${dir}/file${file}.ts`,
).join('\n')).join('\n');

const treeFixture = [
  'project',
  ...Array.from({ length: 260 }, (_, index) => `├── dir${index}\n│   └── file${index}.ts`),
  '260 directories, 260 files',
].join('\n');

const lsFixture = [
  'total 100',
  ...Array.from({ length: 3 }, (_, index) => `drwxr-xr-x  3 user group   4096 Nov 10 12:00 src${index}`),
  'drwxr-xr-x  3 user group   4096 Nov 10 12:00 node_modules',
  ...Array.from({ length: 40 }, (_, index) => `-rw-r--r--  1 user group   1234 Nov 10 12:00 file${index}.ts`),
].join('\n');

const searchListFixture = [
  "Result of search in '/home/gin/work' (total 300 files):",
  ...Array.from({ length: 25 }, (_, dir) => Array.from(
    { length: 12 },
    (_, file) => `- src/dir${dir}/file${file}.ts`,
  ).join('\n')),
].join('\n');

const readNumberedFixture = Array.from(
  { length: 300 },
  (_, index) => `  ${index + 1}|line content ${index} ${'x'.repeat(20)}`,
).join('\n');

const smartTruncateFixture = Array.from(
  { length: 300 },
  (_, index) => `paragraph line ${index} ${'unique prose '.repeat(4)}`,
).join('\n');

const dedupFixture = Array.from({ length: 300 }, () => '2026-01-01 INFO SAME LINE').join('\n');

const buildFixture = [
  ...Array.from({ length: 10 }, (_, index) => `npm warn deprecated oldpkg${index}@1.0.0: use newpkg`),
  ...Array.from({ length: 10 }, (_, index) => `npm warn warning number ${index}`),
  ...Array.from({ length: 30 }, (_, index) => `   Compiling crate_${index} v0.1.0`),
  '   Downloading crate_dep v2.0.0',
  'npm ERR! code ELIFECYCLE',
  'npm ERR! errno 1',
  'error[E0425]: cannot find value `DATABASE_URL` in this scope',
  ' --> src/main.rs:42:10',
  '  |',
  '42 |     let x = DATABASE_URL;',
  '  |             ^^^^^^^^^^^^ not found in this scope',
  'added 123 packages, and audited 200 packages in 3s',
].join('\n');

function markerId(text) {
  const match = /<<token-saver:([a-f0-9]+) /.exec(text);
  return match?.[1];
}

function assertReversible(original, compressed, store) {
  const id = markerId(compressed);
  assert.ok(id, 'no retrieval marker');
  assert.equal(retrieve(store, id), original);
}

function compressedWith(filter, input, options = {}) {
  const store = new MemoryCcrStore();
  const output = compressRtk(input, { ccr: store, ...options });
  assert.ok(output, `${filter}: nothing was compressed`);
  assert.equal(output.filter, filter);
  assert.ok(output.result.length < input.length, `${filter}: rewrite grew the input`);
  return { output, store };
}

test('git-diff keeps file headers and changed lines, drops index/---/+++, caps hunks', () => {
  const { output, store } = compressedWith('git-diff', diffFixture);
  assert.match(output.result, /src\/file0\.ts/);
  assert.match(output.result, /IMPORTANT_ADDED_0/);
  assert.match(output.result, /IMPORTANT_ADDED_11/);
  assert.doesNotMatch(output.result, /^index /m);
  assert.equal(output.kind, 'code');
  assertReversible(diffFixture, output.result, store);

  const hugeStore = new MemoryCcrStore();
  const huge = compressRtk(hugeHunk, { ccr: hugeStore });
  assert.ok(huge);
  assert.equal(huge.filter, 'git-diff');
  assert.match(huge.result, /\+added line 0/);
  assert.doesNotMatch(huge.result, /\+added line 149/);
  assert.match(huge.result, /50 lines truncated/);
  assertReversible(hugeHunk, huge.result, hugeStore);
});

test('git-status keeps branch and paths, caps each section at 10', () => {
  const { output, store } = compressedWith('git-status', statusFixture);
  assert.match(output.result, /\* main/);
  assert.match(output.result, /\+ Staged: 30 files/);
  assert.match(output.result, /src\/staged0\.ts/);
  assert.match(output.result, /src\/modified0\.ts/);
  assert.match(output.result, /src\/untracked0\.ts/);
  assert.doesNotMatch(output.result, /src\/staged29\.ts/);
  assert.match(output.result, /\.\.\. \+20 more/);
  assert.equal(output.kind, 'text');
  assertReversible(statusFixture, output.result, store);
});

test('git-log keeps commit, author, date and subject, drops bodies, caps at 200 lines', () => {
  const { output, store } = compressedWith('git-log', logFixture);
  assert.match(output.result, /commit 0000000000000000000000000000000000000000/);
  assert.match(output.result, /Subject: subject for commit 0/);
  assert.match(output.result, /Author: A <a0@example.com>/);
  assert.doesNotMatch(output.result, /body line one for 0/);
  assert.ok(output.result.split('\n').length <= 202, 'git-log line cap did not hold');
  assert.equal(output.kind, 'log');
  assertReversible(logFixture, output.result, store);
});

test('grep groups by file, keeps match lines, caps at 10 matches per file', () => {
  const { output, store } = compressedWith('grep', grepFixture);
  assert.match(output.result, /\[file\] src\/module0\.ts \(15\):/);
  assert.match(output.result, /MATCH_0_0/);
  assert.match(output.result, /MATCH_29_0/);
  assert.doesNotMatch(output.result, /MATCH_0_14/);
  assert.match(output.result, /\+5/);
  assert.equal(output.kind, 'search');
  assertReversible(grepFixture, output.result, store);
});

test('find groups by dir, caps 10 files per dir and 20 dirs', () => {
  const { output, store } = compressedWith('find', findFixture);
  assert.match(output.result, /file0\.ts/);
  assert.match(output.result, /pkg0\/  \(12\)/);
  assert.match(output.result, /\+5 more dirs/);
  assert.match(output.result, /  \+2/);
  assert.equal(output.kind, 'search');
  assertReversible(findFixture, output.result, store);
});

test('tree drops the summary and caps at 200 lines', () => {
  const { output, store } = compressedWith('tree', treeFixture);
  assert.match(output.result, /dir0/);
  assert.doesNotMatch(output.result, /directories, 260 files/);
  assert.match(output.result, /\.\.\. \+321 more lines/);
  assert.equal(output.kind, 'text');
  assertReversible(treeFixture, output.result, store);
});

test('ls compacts rows, skips noise dirs and prints a summary', () => {
  const { output, store } = compressedWith('ls', lsFixture);
  assert.match(output.result, /src0\//);
  assert.match(output.result, /file0\.ts\s+1\.2K/);
  assert.doesNotMatch(output.result, /node_modules/);
  assert.match(output.result, /Summary: 40 files, 3 dirs/);
  assert.equal(output.kind, 'text');
  assertReversible(lsFixture, output.result, store);
});

test('search-list keeps the header, groups paths and caps dirs/files', () => {
  const { output, store } = compressedWith('search-list', searchListFixture);
  assert.match(output.result, /Result of search in '\/home\/gin\/work' \(total 300 files\):/);
  assert.match(output.result, /file0\.ts/);
  assert.match(output.result, /  \+2/);
  assert.match(output.result, /\+5 more dirs/);
  assert.equal(output.kind, 'search');
  assertReversible(searchListFixture, output.result, store);
});

test('read-numbered keeps head and tail of a numbered file dump', () => {
  const { output, store } = compressedWith('read-numbered', readNumberedFixture);
  assert.match(output.result, /1\|line content 0/);
  assert.match(output.result, /300\|line content 299/);
  assert.match(output.result, /\.\.\. \+120 lines truncated \(file continues\)/);
  assert.equal(output.kind, 'code');
  assertReversible(readNumberedFixture, output.result, store);
});

test('smart-truncate keeps head and tail of an unstructured blob', () => {
  const { output, store } = compressedWith('smart-truncate', smartTruncateFixture, { toolName: 'smart-truncate' });
  assert.match(output.result, /paragraph line 0 /);
  assert.match(output.result, /paragraph line 299 /);
  assert.match(output.result, /\.\.\. \+120 lines truncated/);
  assert.equal(output.kind, 'text');
  assertReversible(smartTruncateFixture, output.result, store);
});

test('dedup-log collapses a repeated line and keeps the distinct one', () => {
  const input = `${dedupFixture}\ndistinct final line`;
  const { output, store } = compressedWith('dedup-log', input);
  assert.match(output.result, /SAME LINE/);
  assert.match(output.result, /\.\.\. \(299 duplicate lines\)/);
  assert.match(output.result, /distinct final line/);
  assert.equal(output.kind, 'log');
  assertReversible(input, output.result, store);
});

test('build-output keeps errors, cargo continuations and the summary, caps warnings', () => {
  const { output, store } = compressedWith('build-output', buildFixture);
  assert.match(output.result, /error\[E0425\]: cannot find value `DATABASE_URL`/);
  assert.match(output.result, /--> src\/main\.rs:42:10/);
  assert.match(output.result, /Compiled 30 packages/);
  assert.match(output.result, /added 123 packages/);
  assert.match(output.result, /\+7 more deprecated packages/);
  assert.match(output.result, /\+5 more warnings/);
  assert.doesNotMatch(output.result, /warning number 9/);
  assert.equal(output.kind, 'log');
  assertReversible(buildFixture, output.result, store);
});

test('autodetect routes each fixture to its filter by content', () => {
  const cases = [
    ['git-diff', diffFixture],
    ['git-status', statusFixture],
    ['git-log', logFixture],
    ['grep', grepFixture],
    ['find', findFixture],
    ['tree', treeFixture],
    ['ls', lsFixture],
    ['search-list', searchListFixture],
    ['read-numbered', readNumberedFixture],
    ['dedup-log', dedupFixture],
    ['build-output', buildFixture],
  ];
  for (const [expected, input] of cases) {
    assert.equal(autoDetectFilter(input), expected, `${expected} fixture was misrouted`);
  }
  assert.equal(autoDetectFilter('a short paragraph about tokens.'), null);
});

test('an explicit tool name wins, but a mismatched payload is not guessed', () => {
  const store = new MemoryCcrStore();
  const byName = compressRtk(diffFixture, { toolName: 'git diff', ccr: store });
  assert.ok(byName);
  assert.equal(byName.filter, 'git-diff');

  const alias = compressRtk(grepFixture, { toolName: 'rg', ccr: store });
  assert.ok(alias);
  assert.equal(alias.filter, 'grep');

  assert.equal(compressRtk(diffFixture, { toolName: 'git-status', ccr: store }), undefined);

  const unknownTool = compressRtk(diffFixture, { toolName: 'some_shell', ccr: store });
  assert.ok(unknownTool);
  assert.equal(unknownTool.filter, 'git-diff', 'unknown tool names should fall back to autodetect');
});

test('no-op and cap guards: tiny, oversized, unmatched and non-saving content', () => {
  const store = new MemoryCcrStore();
  assert.equal(compressRtk('tiny', { ccr: store }), undefined);
  assert.equal(compressRtk('x'.repeat(MIN_COMPRESS_SIZE - 1), { ccr: store }), undefined);
  assert.equal(compressRtk('x'.repeat(RAW_CAP + 1), { ccr: store }), undefined);
  assert.equal(store.size(), 0, 'a rejected input must not be stored');

  const prose = Array.from({ length: 20 }, (_, index) => `A distinct prose line number ${index} with no structure at all.`).join('\n');
  assert.ok(prose.length >= MIN_COMPRESS_SIZE);
  assert.equal(compressRtk(prose, { ccr: store }), undefined);
  assert.equal(store.size(), 0);
});

test('compressMessages routes tool and assistant output through RTK with the filter as strategy', () => {
  const store = new MemoryCcrStore();
  const result = compressMessages([
    { role: 'tool', name: 'git diff', content: diffFixture },
    { role: 'assistant', content: [{ type: 'text', text: grepFixture }] },
  ], { protectRecent: 0, ccr: store });

  assert.equal(result.stats.routes.length, 2);
  assert.equal(result.stats.routes[0].strategy, 'git-diff');
  assert.equal(result.stats.routes[0].kind, 'code');
  assert.match(result.value[0].content, /IMPORTANT_ADDED_0/);
  assert.equal(result.stats.routes[1].strategy, 'grep');
  assert.equal(result.stats.routes[1].kind, 'search');
  assert.match(result.value[1].content[0].text, /MATCH_0_0/);
  assert.equal(result.stats.reversible, true);

  const id = markerId(result.value[0].content);
  assert.equal(retrieve(store, id), diffFixture);
});

test('compressMessages keeps JSON-aware compression for content that parses as JSON', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: index, status: 'ok', payload: 'x'.repeat(200) }));
  const text = JSON.stringify(rows);
  const result = compressMessages([{ role: 'tool', content: text }], {
    protectRecent: 0,
    maxStringChars: 80,
    maxArrayItems: 10,
    ccr: new MemoryCcrStore(),
  });

  assert.equal(result.stats.routes.length, 1);
  assert.equal(result.stats.routes[0].strategy, 'json');
  assert.equal(result.stats.routes[0].kind, 'json');
  assert.doesNotThrow(() => JSON.parse(result.value[0].content));
  assert.ok(result.value[0].content.length < text.length);
});
