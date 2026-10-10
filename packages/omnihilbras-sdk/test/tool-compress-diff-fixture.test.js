import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compressToolResults } from '../dist/index.js';

// A `git diff` is read by a model for what changed. Every hunk header and every changed line is the answer, so the
// filter must keep all of them; only the unchanged context far from a change may be dropped. The fixture is a real
// 3720-line diff of this repository, not one written from memory.

const diff = readFileSync(new URL('./compress-fixtures/real-diff.txt', import.meta.url), 'utf8');

test('a git diff keeps every hunk header and every changed line', () => {
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c-diff', type: 'function', function: { name: 'git_diff', arguments: '{}' } }] },
    { role: 'tool', toolCallId: 'c-diff', content: diff },
  ];
  const [, out] = compressToolResults(messages);
  const before = diff.split('\n');
  const after = out.content.split('\n');
  const changed = before.filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  const kept = new Set(after);
  for (const line of changed) assert.ok(kept.has(line), `a changed line was dropped: ${line.slice(0, 80)}`);
  const hunks = before.filter((line) => line.startsWith('@@'));
  for (const hunk of hunks) assert.ok(kept.has(hunk), `a hunk header was dropped: ${hunk.slice(0, 80)}`);
  assert.ok(out.content.length < diff.length, 'the diff is still smaller');
});

const listing = readFileSync(new URL('./compress-fixtures/real-ls.txt', import.meta.url), 'utf8');

test('a directory listing keeps every directory heading, so the model can see the structure', () => {
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c-ls', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
    { role: 'tool', toolCallId: 'c-ls', content: listing },
  ];
  const [, out] = compressToolResults(messages);
  const headings = listing.split('\n').filter((line) => /^[^ ].*:$/.test(line));
  const kept = new Set(out.content.split('\n'));
  for (const heading of headings) assert.ok(kept.has(heading), `a directory heading was dropped: ${heading}`);
  assert.ok(out.content.length < listing.length, 'the listing is smaller');
  assert.match(out.content, /entries omitted/, 'the omitted entries are counted');
});
