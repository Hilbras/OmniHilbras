/**
 * DeepSeek's proof-of-work, `DeepSeekHashV1`.
 *
 * DeepSeek gates every `/api/v0/chat/completion` call with a small search problem: find a
 * nonce whose hash of `<salt>_<expireAt>_<nonce>` equals a given digest. It is not a
 * leading-zeros problem — the whole 32-byte digest must match, so exactly one nonce in the
 * announced range satisfies it and the work is bounded by that range.
 *
 * The hash is **SHA3-256's sponge with 23 Keccak rounds instead of 24**. That is the entire
 * difference, and it is why `node:crypto` cannot be used for it: the platform gives 24.
 * `sha3_256Fips202Reference` here is the same code at 24 rounds, which *can* be checked
 * against the platform, and that check is what keeps the 23-round version honest.
 *
 * Everything is 32-bit rather than BigInt: a difficulty of 250 000 means 250 000 permutations,
 * and BigInt lanes make that roughly two orders of magnitude slower for no benefit.
 */

const LANE_MASK = (1n << 64n) - 1n;
const RATE_BYTES = 136;
const DOMAIN_SUFFIX = 0x06;
const OUTPUT_BYTES = 32;

/** Indexed as `x + 5*y`, matching the FIPS 202 state coordinates. */
const ROTATION_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const DEEPSEEK_HASH_ROUNDS = 23;
export const MAX_DEEPSEEK_POW_DIFFICULTY = 250_000;

const ROUND_CONSTANTS_LOW = Uint32Array.from(ROUND_CONSTANTS, (v) => Number(v & 0xffffffffn));
const ROUND_CONSTANTS_HIGH = Uint32Array.from(ROUND_CONSTANTS, (v) => Number((v >> 32n) & 0xffffffffn));
const RHO_PI_DESTINATION_WORDS = Uint8Array.from({ length: 25 }, (_, lane) => {
  const x = lane % 5;
  const y = Math.floor(lane / 5);
  return 2 * (y + 5 * ((2 * x + 3 * y) % 5));
});
const CHI_NEXT_WORDS = Uint8Array.from({ length: 25 }, (_, lane) => {
  const x = lane % 5;
  const row = lane - x;
  return 2 * (row + ((x + 1) % 5));
});
const CHI_NEXT_NEXT_WORDS = Uint8Array.from({ length: 25 }, (_, lane) => {
  const x = lane % 5;
  const row = lane - x;
  return 2 * (row + ((x + 2) % 5));
});
const HEX_DIGITS = '0123456789abcdef';

function rotateLeft64(value: bigint, amount: number): bigint {
  if (amount === 0) return value;
  const shift = BigInt(amount);
  return ((value << shift) | (value >> (64n - shift))) & LANE_MASK;
}

/** The last `roundCount` rounds of KECCAK-p[1600, roundCount], in BigInt. Readable, not fast. */
function keccakP1600Reference(state: bigint[], roundCount: number): void {
  const columnParity = new Array<bigint>(5).fill(0n);
  const thetaMix = new Array<bigint>(5).fill(0n);
  const rhoPiState = new Array<bigint>(25).fill(0n);
  const firstRound = ROUND_CONSTANTS.length - roundCount;

  for (let round = firstRound; round < ROUND_CONSTANTS.length; round++) {
    for (let x = 0; x < 5; x++) {
      columnParity[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      thetaMix[x] = columnParity[(x + 4) % 5]! ^ rotateLeft64(columnParity[(x + 1) % 5]!, 1);
    }
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) state[x + 5 * y] = state[x + 5 * y]! ^ thetaMix[x]!;

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const destinationX = y;
        const destinationY = (2 * x + 3 * y) % 5;
        rhoPiState[destinationX + 5 * destinationY] = rotateLeft64(
          state[x + 5 * y]!,
          ROTATION_OFFSETS[x + 5 * y]!,
        );
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const row = 5 * y;
        state[x + row] =
          rhoPiState[x + row]! ^ (~rhoPiState[((x + 1) % 5) + row]! & LANE_MASK & rhoPiState[((x + 2) % 5) + row]!);
      }
    }
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

function absorbReferenceBlock(state: bigint[], block: Uint8Array, roundCount: number): void {
  for (let index = 0; index < RATE_BYTES; index++) {
    const lane = Math.floor(index / 8);
    state[lane] = state[lane]! ^ (BigInt(block[index]!) << BigInt((index % 8) * 8));
  }
  keccakP1600Reference(state, roundCount);
}

/** SHA3-256's sponge with a selectable round count, in BigInt. The readable model. */
function sha3_256ReferenceWithRoundCount(input: string, roundCount: number): string {
  const bytes = new TextEncoder().encode(input);
  const state = new Array<bigint>(25).fill(0n);
  let offset = 0;
  while (offset + RATE_BYTES <= bytes.length) {
    absorbReferenceBlock(state, bytes.subarray(offset, offset + RATE_BYTES), roundCount);
    offset += RATE_BYTES;
  }
  const finalBlock = new Uint8Array(RATE_BYTES);
  finalBlock.set(bytes.subarray(offset));
  finalBlock[bytes.length - offset] = finalBlock[bytes.length - offset]! ^ DOMAIN_SUFFIX;
  finalBlock[RATE_BYTES - 1] = finalBlock[RATE_BYTES - 1]! ^ 0x80;
  absorbReferenceBlock(state, finalBlock, roundCount);

  const output = new Uint8Array(OUTPUT_BYTES);
  for (let index = 0; index < output.length; index++) {
    const lane = state[Math.floor(index / 8)]!;
    output[index] = Number((lane >> BigInt((index % 8) * 8)) & 0xffn);
  }
  return Array.from(output, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA3-256 proper, at 24 rounds.
 *
 * Exported only so the 23-round implementation below can be checked against the platform:
 * this one must equal `node:crypto`'s SHA3-256 for every input, and if it does not, neither
 * does the other.
 */
export function sha3_256Fips202Reference(input: string): string {
  return sha3_256ReferenceWithRoundCount(input, 24);
}

/** `DeepSeekHashV1` as a readable model. For tests, not for a 250 000-iteration search. */
export function deepSeekHashV1Reference(input: string): string {
  return sha3_256ReferenceWithRoundCount(input, DEEPSEEK_HASH_ROUNDS);
}

/** The same permutation in 32-bit words. Each 64-bit lane is adjacent little-endian words. */
function keccakP1600Uint32(
  state: Uint32Array,
  rhoPiState: Uint32Array,
  columnParity: Uint32Array,
  thetaMix: Uint32Array,
  roundCount: number,
): void {
  const firstRound = ROUND_CONSTANTS.length - roundCount;
  for (let round = firstRound; round < ROUND_CONSTANTS.length; round++) {
    for (let x = 0; x < 5; x++) {
      const word = 2 * x;
      columnParity[word] = state[word]! ^ state[word + 10]! ^ state[word + 20]! ^ state[word + 30]! ^ state[word + 40]!;
      columnParity[word + 1] = state[word + 1]! ^ state[word + 11]! ^ state[word + 21]! ^ state[word + 31]! ^ state[word + 41]!;
    }
    for (let x = 0; x < 5; x++) {
      const previous = 2 * ((x + 4) % 5);
      const next = 2 * ((x + 1) % 5);
      const rotatedLow = (columnParity[next]! << 1) | (columnParity[next + 1]! >>> 31);
      const rotatedHigh = (columnParity[next + 1]! << 1) | (columnParity[next]! >>> 31);
      thetaMix[2 * x] = columnParity[previous]! ^ rotatedLow;
      thetaMix[2 * x + 1] = columnParity[previous + 1]! ^ rotatedHigh;
    }
    for (let x = 0; x < 5; x++) {
      const word = 2 * x;
      /**
       * XOR, and it has to be XOR.
       *
       * `|=` is tempting here and is wrong: a lane that already has bits set, XORed with a
       * theta value sharing any of those bits, clears them — OR keeps them. The 24-round
       * control does not catch this, because it runs the BigInt path; only the comparison
       * between the fast path and the readable model does.
       */
      const low = thetaMix[word]!;
      const high = thetaMix[word + 1]!;
      for (const target of [word, word + 10, word + 20, word + 30, word + 40]) {
        state[target] = state[target]! ^ low;
        state[target + 1] = state[target + 1]! ^ high;
      }
    }

    rhoPiState[0] = state[0]!;
    rhoPiState[1] = state[1]!;
    for (let lane = 1; lane < 25; lane++) {
      const source = 2 * lane;
      const destination = RHO_PI_DESTINATION_WORDS[lane]!;
      const amount = ROTATION_OFFSETS[lane]!;
      const low = state[source]!;
      const high = state[source + 1]!;
      if (amount < 32) {
        rhoPiState[destination] = (low << amount) | (high >>> (32 - amount));
        rhoPiState[destination + 1] = (high << amount) | (low >>> (32 - amount));
      } else {
        const reduced = amount - 32;
        rhoPiState[destination] = (high << reduced) | (low >>> (32 - reduced));
        rhoPiState[destination + 1] = (low << reduced) | (high >>> (32 - reduced));
      }
    }
    for (let lane = 0; lane < 25; lane++) {
      const word = 2 * lane;
      const nextWord = CHI_NEXT_WORDS[lane]!;
      const nextNextWord = CHI_NEXT_NEXT_WORDS[lane]!;
      state[word] = rhoPiState[word]! ^ (~rhoPiState[nextWord]! & rhoPiState[nextNextWord]!);
      state[word + 1] = rhoPiState[word + 1]! ^ (~rhoPiState[nextWord + 1]! & rhoPiState[nextNextWord + 1]!);
    }
    state[0] = state[0]! ^ ROUND_CONSTANTS_LOW[round]!;
    state[1] = state[1]! ^ ROUND_CONSTANTS_HIGH[round]!;
  }
}

function absorbFullUint32Block(
  state: Uint32Array,
  bytes: Uint8Array,
  offset: number,
  rhoPiState: Uint32Array,
  columnParity: Uint32Array,
  thetaMix: Uint32Array,
  roundCount: number,
): void {
  for (let index = 0; index < RATE_BYTES; index++) {
    state[index >>> 2]! ^= bytes[offset + index]! << ((index & 3) * 8);
  }
  keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, roundCount);
}

function digestStateToHex(state: Uint32Array): string {
  let digest = '';
  for (let index = 0; index < OUTPUT_BYTES; index++) {
    const byte = (state[index >>> 2]! >>> ((index & 3) * 8)) & 0xff;
    digest += HEX_DIGITS[byte >>> 4]! + HEX_DIGITS[byte & 0x0f]!;
  }
  return digest;
}

function sha3_256Uint32WithRoundCount(input: string, roundCount: number): string {
  const bytes = new TextEncoder().encode(input);
  const state = new Uint32Array(50);
  const rhoPiState = new Uint32Array(50);
  const columnParity = new Uint32Array(10);
  const thetaMix = new Uint32Array(10);
  let offset = 0;

  while (offset + RATE_BYTES <= bytes.length) {
    absorbFullUint32Block(state, bytes, offset, rhoPiState, columnParity, thetaMix, roundCount);
    offset += RATE_BYTES;
  }
  const remaining = bytes.length - offset;
  for (let index = 0; index < remaining; index++) {
    state[index >>> 2]! ^= bytes[offset + index]! << ((index & 3) * 8);
  }
  state[remaining >>> 2]! ^= DOMAIN_SUFFIX << ((remaining & 3) * 8);
  state[(RATE_BYTES - 1) >>> 2]! ^= 0x80 << 24;
  keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, roundCount);
  return digestStateToHex(state);
}

/** `DeepSeekHashV1`, allocation-bounded. */
export function deepSeekHashV1(input: string): string {
  return sha3_256Uint32WithRoundCount(input, DEEPSEEK_HASH_ROUNDS);
}

function parseDigestWords(digestHex: string): Uint32Array {
  const words = new Uint32Array(OUTPUT_BYTES / 4);
  for (let index = 0; index < OUTPUT_BYTES; index++) {
    const byte = Number.parseInt(digestHex.slice(index * 2, index * 2 + 2), 16);
    words[index >>> 2]! |= byte << ((index & 3) * 8);
  }
  return words;
}

/**
 * Finds the nonce, or -1 if the range does not contain one.
 *
 * The prefix is absorbed **once** and the state is copied per candidate, so a 250 000-wide
 * search re-encodes nothing. Inputs are validated here as well as at the solver boundary, so
 * a hostile challenge cannot coerce this into an unbounded loop or an oversized allocation.
 */
export function findDeepSeekPowNonce(prefix: string, challenge: string, difficulty: number): number {
  if (typeof prefix !== 'string') throw new TypeError('DeepSeek PoW prefix must be a string');
  if (!/^[a-f0-9]{64}$/i.test(challenge)) {
    throw new TypeError('DeepSeek PoW challenge must be a 64-character hex digest');
  }
  if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > MAX_DEEPSEEK_POW_DIFFICULTY) {
    throw new RangeError(
      `DeepSeek PoW difficulty must be an integer from 1 to ${MAX_DEEPSEEK_POW_DIFFICULTY}`,
    );
  }

  const prefixBytes = new TextEncoder().encode(prefix);
  const baseState = new Uint32Array(50);
  const rhoPiState = new Uint32Array(50);
  const columnParity = new Uint32Array(10);
  const thetaMix = new Uint32Array(10);
  let prefixOffset = 0;
  while (prefixOffset + RATE_BYTES <= prefixBytes.length) {
    absorbFullUint32Block(baseState, prefixBytes, prefixOffset, rhoPiState, columnParity, thetaMix, DEEPSEEK_HASH_ROUNDS);
    prefixOffset += RATE_BYTES;
  }
  const tailLength = prefixBytes.length - prefixOffset;
  const tailWords = new Uint32Array(Math.ceil(tailLength / 4) + 1);
  for (let index = 0; index < tailLength; index++) {
    tailWords[index >>> 2]! ^= prefixBytes[prefixOffset + index]! << ((index & 3) * 8);
  }

  const targetWords = parseDigestWords(challenge.toLowerCase());
  const state = new Uint32Array(50);

  nonceLoop: for (let nonce = 0; nonce < difficulty; nonce++) {
    state.set(baseState);
    for (let word = 0; word < tailWords.length; word++) state[word]! ^= tailWords[word]!;

    let position = tailLength;
    const nonceText = String(nonce);
    for (let index = 0; index < nonceText.length; index++) {
      state[position >>> 2]! ^= nonceText.charCodeAt(index) << ((position & 3) * 8);
      position += 1;
      if (position === RATE_BYTES) {
        keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, DEEPSEEK_HASH_ROUNDS);
        position = 0;
      }
    }
    state[position >>> 2]! ^= DOMAIN_SUFFIX << ((position & 3) * 8);
    state[(RATE_BYTES - 1) >>> 2]! ^= 0x80 << 24;
    keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, DEEPSEEK_HASH_ROUNDS);

    for (let word = 0; word < targetWords.length; word++) {
      if (state[word] !== targetWords[word]) continue nonceLoop;
    }
    return nonce;
  }
  return -1;
}
