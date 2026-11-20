import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createOutput } from '../cli/lib/output.mjs';

function capture({ json = false, isTTY = false } = {}) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.isTTY = isTTY;
  return { out: createOutput({ json, stream }), text: () => chunks.join('') };
}

test('box draws a framed card with a separator under the title', () => {
  const { out, text } = capture();
  out.box('● gateway 3.88.0', ['url  http://127.0.0.1:20138', 'auth api-key']);
  const lines = text().split('\n');
  assert.match(lines[0], /^\+-+\+$/, 'ASCII border when stdout is not a terminal');
  assert.match(lines.at(-2), /^\+-+\+$/, 'bottom border');
  assert.match(text(), /\| ● gateway 3\.88\.0\s+\|/);
  assert.match(text(), /\| url  http:\/\/127\.0\.0\.1:20138\s+\|/);
});

test('box prints nothing in --json mode, so the answer stays machine-readable', () => {
  const { out, text } = capture({ json: true });
  out.box('title', ['a row']);
  assert.equal(text(), '');
});
