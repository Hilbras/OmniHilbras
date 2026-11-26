import assert from 'node:assert/strict';
import test from 'node:test';
import { score } from '../dist/src/score.js';

test('exact, contains and regex are strict about what they claim', () => {
  assert.equal(score('hello', { kind: 'exact', value: 'hello' }).passed, true);
  assert.equal(score('hello!', { kind: 'exact', value: 'hello' }).passed, false);
  assert.equal(score('Well, HELLO there', { kind: 'contains', value: 'hello', caseInsensitive: true }).passed, true);
  assert.equal(score('nope', { kind: 'regex', pattern: '^yes$' }).passed, false);
});

test('a JSON subset checks the named fields and ignores the rest', () => {
  assert.equal(score('{"a":1,"b":{"c":2},"extra":true}', { kind: 'json', subset: { b: { c: 2 } } }).passed, true);
  assert.equal(score('{"a":1,"b":{"c":3}}', { kind: 'json', subset: { b: { c: 2 } } }).passed, false);
  assert.equal(score('not json', { kind: 'json', subset: { a: 1 } }).passed, false);
});

test('a number is inside its tolerance or it is not', () => {
  assert.equal(score('10.4', { kind: 'number', value: 10, tolerance: 0.5 }).passed, true);
  assert.equal(score('10.6', { kind: 'number', value: 10, tolerance: 0.5 }).passed, false);
  assert.equal(score('ten', { kind: 'number', value: 10 }).passed, false);
});
