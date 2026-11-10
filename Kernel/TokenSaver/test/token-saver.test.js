import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryCcrStore,
  compressMessages,
  compressJsonText,
  compressLog,
  compressText,
  countMessageTokens,
  detectContentKind,
  retrieve,
} from '../dist/index.js';

/**
 * The standalone token saver.
 *
 * The invariants are the product: structure stays valid, the failure line survives, the last turns are
 * untouched, and every lossy rewrite can be retrieved. A compressor that saves tokens by dropping the
 * FATAL line has not saved anything.
 */

test('content routing separates JSON, logs, search-shaped output and prose', () => {
  assert.equal(detectContentKind('{"a":1}'), 'json');
  assert.equal(detectContentKind('[1,2,3]'), 'json');
  assert.equal(detectContentKind('2026-01-01 ERROR boom\nstack: at x (a.js:1:2)\n2026-01-01 INFO ok'), 'log');
  assert.equal(detectContentKind('src/a.ts:12:3: hit\nsrc/b.ts:44:1: hit'), 'search');
  assert.equal(detectContentKind('A normal paragraph about tokens.'), 'text');
});

test('JSON keeps valid structure, keeps error rows and stays reversible', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: index, status: 'ok', payload: 'x'.repeat(200) }));
  rows.push({ id: 'fatal', status: 'error', message: 'FATAL: database is locked' });
  const text = JSON.stringify(rows);
  const store = new MemoryCcrStore();
  const compressed = compressJsonText(text, { maxStringChars: 80, maxArrayItems: 10, reversible: true, ccr: store });
  assert.ok(compressed, 'nothing was compressed');
  const parsed = JSON.parse(compressed);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some((row) => row.status === 'error'), 'the error row was dropped');
  assert.ok(parsed.some((row) => row._token_saver), 'no row-drop sentinel');
  assert.ok(compressed.length < text.length);
  const marker = /token-saver:([a-f0-9]+)/.exec(compressed);
  assert.ok(marker, 'no retrieval marker');
  assert.equal(retrieve(store, marker[1]), text);
});

test('logs preserve FATAL/ERROR with context and collapse repetition', () => {
  const lines = ['test startup'];
  for (let index = 0; index < 150; index += 1) lines.push(`2026-01-01 INFO progress ${index}`);
  lines.push('2026-01-01 INFO opening database');
  lines.push('2026-01-01 ERROR FATAL: database is locked');
  lines.push('    at open (db.js:42:7)');
  lines.push('2026-01-01 INFO done');
  const text = lines.join('\n');
  const store = new MemoryCcrStore();
  const compressed = compressLog(text, { targetRatio: 0.3, ccr: store, reversible: true });
  assert.ok(compressed);
  assert.match(compressed, /FATAL: database is locked/);
  assert.match(compressed, /at open \(db\.js:42:7\)/);
  assert.ok(compressed.length < text.length / 2);
  const marker = /token-saver:([a-f0-9]+)/.exec(compressed);
  assert.equal(retrieve(store, marker[1]), text);
});

test('text keeps query-relevant paragraphs and marks elision', () => {
  const relevant = 'Redis connection pooling is the failure. The pool is exhausted by streaming responses.';
  const paragraphs = Array.from({ length: 60 }, (_, index) => `Background note ${index}: ${'filler '.repeat(40)}`);
  paragraphs.push(relevant);
  const text = paragraphs.join('\n\n');
  const store = new MemoryCcrStore();
  const compressed = compressText(text, { targetRatio: 0.2, query: 'why is redis pooling failing', ccr: store, reversible: true });
  assert.ok(compressed);
  assert.match(compressed, /Redis connection pooling/);
  assert.match(compressed, /elided/);
  assert.ok(compressed.length < text.length);
  const marker = /token-saver:([a-f0-9]+)/.exec(compressed);
  assert.equal(retrieve(store, marker[1]), text);
});

test('messages protect recent turns, skip user instructions, and compress tool output', () => {
  const log = Array.from({ length: 100 }, (_, index) => `2026-01-01 INFO line ${index}`).join('\n') + '\n2026-01-01 ERROR FATAL: nope';
  const messages = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'tool', content: log },
    { role: 'user', content: 'keep this instruction exactly as written' },
    { role: 'assistant', content: 'recent answer should stay' },
    { role: 'user', content: 'recent question should stay' },
  ];
  const before = countMessageTokens(messages);
  const result = compressMessages(messages, { protectRecent: 2, compressUsers: false });
  assert.equal(result.value[1].content.includes('FATAL: nope'), true, 'tool output lost the failure');
  assert.equal(result.value[1].content.length < log.length, true);
  assert.equal(result.value[2].content, 'keep this instruction exactly as written');
  assert.equal(result.value[3].content, 'recent answer should stay');
  assert.equal(result.value[4].content, 'recent question should stay');
  assert.ok(result.stats.savedTokens > 0);
  assert.ok(result.stats.savedTokens <= before);
  assert.equal(result.stats.routes.length, 1);
  assert.equal(result.stats.reversible, true);
});

test('a rewrite that would grow the message is discarded', () => {
  const messages = [{ role: 'tool', content: 'tiny' }];
  const result = compressMessages(messages, { protectRecent: 0, minChars: 1 });
  assert.equal(result.value[0].content, 'tiny');
  assert.equal(result.stats.savedTokens, 0);
});

test('the estimator is deterministic and non-zero for non-empty content', () => {
  assert.equal(countMessageTokens([{ role: 'user', content: 'hello world' }]), 7);
  assert.equal(countMessageTokens([]), 0);
});
