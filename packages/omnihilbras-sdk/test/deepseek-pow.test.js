import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  MAX_DEEPSEEK_POW_DIFFICULTY,
  deepSeekHashV1,
  deepSeekHashV1Reference,
  findDeepSeekPowNonce,
  sha3_256Fips202Reference,
} from '../dist/adapters/deepseek-pow.js';

/**
 * DeepSeek's proof-of-work.
 *
 * The hash is SHA3-256's sponge at **23** Keccak rounds instead of 24, which is why
 * `node:crypto` cannot do it. That makes correctness hard to eyeball, so the tests pin it
 * from two directions: the 24-round control against the platform, and the 23-round fast path
 * against a readable BigInt model of the same permutation.
 */

/** Vectors chosen to cover the boundaries the sponge has: empty, one block, and across two. */
const VECTORS = [
  '',
  'abc',
  'a'.repeat(135),
  'a'.repeat(136),
  'a'.repeat(137),
  'a'.repeat(300),
  'héllo 🌍 ünïcode',
  'x'.repeat(1000),
  'y'.repeat(5000),
];

test('the permutation is right, because the 24-round control matches the platform', () => {
  // If this fails, the padding, byte order and multi-block absorption are all wrong and
  // nothing else in this file means anything.
  for (const input of VECTORS) {
    assert.equal(
      sha3_256Fips202Reference(input),
      createHash('sha3-256').update(input).digest('hex'),
      `the 24-round control disagrees with node:crypto on ${JSON.stringify(input.slice(0, 12))}`,
    );
  }
});

test('the 32-bit fast path is the same permutation as the readable model', () => {
  // The fast path exists because a 250 000-wide search in BigInt is far too slow. This is
  // what stops that optimisation from being a silent second implementation.
  for (const input of VECTORS) {
    assert.equal(deepSeekHashV1(input), deepSeekHashV1Reference(input));
  }
});

test('the round count is what makes it different, and it is 23', () => {
  // If these ever matched, the whole premise — that the platform cannot compute it — would
  // be wrong and the file could be deleted.
  for (const input of VECTORS) {
    assert.notEqual(deepSeekHashV1(input), sha3_256Fips202Reference(input));
  }
});

test('a planted nonce is found, at both ends and in the middle of the range', () => {
  for (const nonce of [0, 1, 2, 4242, 99_999]) {
    const prefix = 'abc123_1790579999_';
    const challenge = deepSeekHashV1(`${prefix}${nonce}`);
    assert.equal(findDeepSeekPowNonce(prefix, challenge, 100_000), nonce, `nonce ${nonce} was not found`);
    // And the answer really does satisfy the challenge, which is what DeepSeek checks.
    assert.equal(deepSeekHashV1(`${prefix}${nonce}`), challenge);
  }
});

test('a challenge outside the announced range says so instead of searching forever', () => {
  const prefix = 'abc_1790579999_';
  const challenge = deepSeekHashV1(`${prefix}99999`);
  assert.equal(findDeepSeekPowNonce(prefix, challenge, 100), -1);
});

test('a challenge nobody can satisfy within the cap is reported, not retried', () => {
  // A digest nothing hashes to. Returning -1 is the honest answer; looping or throwing would
  // both turn a server's mistake into a hung request.
  const prefix = 'abc_1790579999_';
  assert.equal(findDeepSeekPowNonce(prefix, 'f'.repeat(64), 1000), -1);
});

test('hostile challenge input is refused before any work is done', () => {
  // The challenge arrives from a server and is used to size a loop, so it is untrusted.
  const prefix = 'abc_1790579999_';
  const good = deepSeekHashV1(`${prefix}1`);
  assert.throws(() => findDeepSeekPowNonce(prefix, 'not-a-digest', 100), /64-character hex/);
  assert.throws(() => findDeepSeekPowNonce(prefix, good, 0), /integer from 1 to/);
  assert.throws(() => findDeepSeekPowNonce(prefix, good, 1e9), /integer from 1 to/);
  assert.throws(() => findDeepSeekPowNonce(prefix, good, -1), /integer from 1 to/);
  assert.throws(() => findDeepSeekPowNonce(prefix, good, 1.5), /integer from 1 to/);
});

test('the difficulty cap is the documented one', () => {
  // 250 000 is a linear scan of full permutations. It is a bound the reference announces,
  // not a tuning choice, so it is pinned rather than derived.
  assert.equal(MAX_DEEPSEEK_POW_DIFFICULTY, 250_000);
});
