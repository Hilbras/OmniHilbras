import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import deepseekWebEntry from "../providers/registry/deepseek-web.js";
import {
  DEEPSEEK_WEB,
  DeepSeekWebError,
  deepSeekFingerprintHeaders,
  deepSeekRefusal,
  fetchDeepSeekAccessToken,
  parseDeepSeekUserToken,
  unwrapDeepSeekBizData,
} from "../shared/webSession/deepseek-web.js";

/**
 * DeepSeek Web — the turn, against the web client's own API.
 *
 * **No browser is needed for a turn.** The web client is an HTTP API behind a
 * session token, so this is a normal fetch with a bearer credential. A browser
 * is only involved in *getting* the token, which the user does by copying one
 * value out of the console.
 *
 * Two things make the request path non-obvious, and both are load-bearing:
 *
 *  - **The token is exchanged, not used.** `userToken` only authorises
 *    `users/current`, which hands back a short-lived `accessToken` for
 *    everything else. Sending the userToken at the completion endpoint gets a
 *    401 that looks like an expired session.
 *  - **Every completion is gated by a proof of work** — see the solver below.
 *    It is a bounded search, not a wall, and the answer goes in
 *    `X-Ds-Pow-Response`.
 *
 * The flow is four calls: exchange the token, start a chat session, solve the
 * proof of work, then post the completion. The access token is cached for an
 * hour, because it is the same value for every request in that window and a
 * turn otherwise spends two round trips before it sends anything.
 *
 * Ported from the previous project's `deepseek-web` provider.
 */

/**
 * The models chat.deepseek.com serves, and the three flags the endpoint wants.
 *
 * Two of the flags are in the id rather than a separate parameter: `think` and
 * `search` are model variants the page offers, not request options. A Pro
 * model is `model_type: "expert"`; everything else is `"default"`.
 */
const DEEPSEEK_WEB_MODELS = {
  "deepseek-v4-pro": { expert: true, thinking: false, search: false },
  "deepseek-v4-pro-think": { expert: true, thinking: true, search: false },
  "deepseek-v4-pro-search": { expert: true, thinking: false, search: true },
  "deepseek-v4-pro-think-search": { expert: true, thinking: true, search: true },
  "deepseek-v4-flash": { expert: false, thinking: false, search: false },
  "deepseek-v4-flash-think": { expert: false, thinking: true, search: false },
  "deepseek-v4-flash-search": { expert: false, thinking: false, search: true },
  "deepseek-v4-flash-think-search": { expert: false, thinking: true, search: true },
  "deepseek-chat": { expert: false, thinking: false, search: false },
  "deepseek-reasoner": { expert: false, thinking: true, search: false },
  "DeepSeek-R1": { expert: false, thinking: true, search: false },
  "DeepSeek-R1-Search": { expert: false, thinking: true, search: true },
  "DeepSeek-V3.2": { expert: false, thinking: false, search: false },
  "DeepSeek-Search": { expert: false, thinking: false, search: true },
};

/** Case-insensitive, because a client is free to lowercase the id it was given. */
const MODEL_LOOKUP = new Map(
  Object.entries(DEEPSEEK_WEB_MODELS).map(([id, spec]) => [id.toLowerCase(), { id, ...spec }]),
);

export function lookupDeepSeekWebModel(modelId) {
  const wanted = String(modelId ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return MODEL_LOOKUP.get(wanted) ?? null;
}

/** An access token is good for about an hour; a minute of slack, so it cannot expire mid-turn. */
const ACCESS_TOKEN_TTL_MS = 55 * 60_000;

/**
 * The cap on the answer we read.
 *
 * The cap is not paranoia about a hostile server so much as about an endless
 * one: a stream that never terminates will grow a buffer until the process is
 * killed, and the failure then reads as an out-of-memory crash rather than as
 * an upstream that never finished.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
      return "";
    })
    .join("");
}

/**
 * Flattens a message list into the single prompt the endpoint takes.
 *
 * The endpoint takes one flat `prompt`, not a message array. History is
 * flattened into it: a system turn is prefixed as an instruction and earlier
 * turns are labelled, because there is nowhere else to put them. Dropping them
 * silently would answer the last line and look like it had read the rest.
 *
 * Labelled rather than concatenated, because a bare join of
 * `["You are terse.", "2+2?"]` loses which was which.
 */
export function flattenToPrompt(messages) {
  const kept = (messages || []).filter((message) => message.text?.trim());
  const system = kept.filter((message) => message.role === "system");
  const rest = kept.filter((message) => message.role !== "system");
  const lines = [];
  if (system.length > 0) {
    lines.push("Follow these instructions:", ...system.map((message) => `- ${message.text.trim()}`), "");
  }
  for (const message of rest) {
    lines.push(`${message.role === "assistant" ? "Assistant" : "User"}: ${message.text.trim()}`);
  }
  return lines.join("\n").trim();
}

/**
 * Reads a completed answer out of DeepSeek's SSE body.
 *
 * Captured from a live stream rather than assumed, and the shape is not what
 * it looks like. A real reply to "Count from 1 to 5" arrives as:
 *
 * ```text
 * data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"RESPONSE","content":"1"}]}}}
 * data: {"p":"response/fragments/-1/content","o":"APPEND","v":","}
 * data: {"v":" "}
 * data: {"v":"2"}
 * data: {"v":","}
 * data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":60}]}
 * data: {"p":"response/status","o":"SET","v":"FINISHED"}
 * ```
 *
 * **Only the first line is a fragment object.** The rest of the answer is a
 * run of frames whose value is a bare string, most of them carrying no path at
 * all. A decoder that only recognises fragment objects keeps the opening
 * character and discards the rest — which is exactly what happened: every
 * answer came back one character long, `finish_reason: stop`, looking like a
 * working model that happened to be terse. "Count from 1 to 10" returned `1`.
 *
 * Two more things the stream requires:
 *
 * **The path is positional, and the last stated one wins.** A thinking model
 * interleaves `THINK` and `RESPONSE` fragments, and an untyped append belongs
 * to whichever was last.
 *
 * **`FINISHED` is a status word, not text.** `{"p":"response/status","v":"FINISHED"}`
 * has a string value, so a decoder that appends every string value writes the
 * literal word `FINISHED` onto the end of the answer. It is consumed as
 * status here, and the absence of it is reported: a body that closes without
 * `FINISHED` was cut off mid-generation, and reporting that as a clean answer
 * is the same fault as not reading the stream at all.
 */
export function decodeDeepSeekAnswer(body) {
  let content = "";
  let reasoning = "";
  // Which side an untyped append belongs to, from the last fragment or response that said so.
  let currentPath = "content";
  let finished = false;
  // DeepSeek reports the token count in a metadata batch; it is used when it is there.
  let usage = 0;

  const append = (text) => {
    if (!text) return;
    if (currentPath === "thinking") reasoning += text;
    else content += text;
  };

  const applyType = (fragment) => {
    const type = String(fragment.type ?? "").toUpperCase();
    if (type === "THINK") currentPath = "thinking";
    else if (type === "ANSWER" || type === "RESPONSE") currentPath = "content";
  };

  const takeFragment = (fragment, pathFromType) => {
    if (!fragment || typeof fragment !== "object") return;
    const record = fragment;
    if (pathFromType) applyType(record);
    if (typeof record.content !== "string" || record.content.length === 0) return;
    if (!pathFromType) applyType(record);
    append(record.content);
  };

  for (const rawLine of String(body ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const frame = parsed;
    const path = typeof frame.p === "string" ? frame.p : "";
    const value = frame.v;

    // Status, not an answer. Checked before the string branch below, deliberately.
    if (path === "response/status" && value === "FINISHED") {
      finished = true;
      continue;
    }
    if (path === "response/search_status" || path === "response/search_results") continue;

    // A whole response: it declares the path and carries its own fragments.
    if (value && typeof value === "object" && !Array.isArray(value) && "response" in value) {
      const response = value.response;
      if (response.thinking_enabled === true) currentPath = "thinking";
      else if (response.thinking_enabled === false) currentPath = "content";
      if (Array.isArray(response.fragments)) for (const fragment of response.fragments) takeFragment(fragment, false);
    }

    if (path === "response/fragments") {
      if (Array.isArray(value)) for (const fragment of value) takeFragment(fragment, true);
      else takeFragment(value, true);
      continue;
    }

    // A metadata batch: token counts and status words, never text.
    if (path === "response" && Array.isArray(value)) {
      for (const entry of value) {
        if (entry?.p === "response" && entry.v?.thinking_enabled === true) currentPath = "thinking";
        if (entry?.p === "accumulated_token_usage" && typeof entry.v === "number") usage = entry.v;
      }
      continue;
    }

    // Most of a normal answer, and the part that was being dropped.
    if (typeof value === "string") append(value);
  }

  /**
   * Not trimmed, deliberately.
   *
   * This decoder used to end with `content.trim()` and `reasoning.trim()`, which
   * silently removed the leading and trailing whitespace of every answer. It
   * was the only adapter in the SDK that did this, and the loss is not
   * something a client can detect: an answer that was asked to be exactly
   * `"  indented  "` arrives as `"indented"`, and a code answer loses its
   * trailing newlines, which is visible as badly-indented code rather than as
   * a truncated one.
   */
  return { content, reasoning, finished, usage };
}

/**
 * DeepSeek's proof of work, `DeepSeekHashV1`.
 *
 * DeepSeek gates every `/api/v0/chat/completion` call with a small search
 * problem: find a nonce whose hash of `<salt>_<expireAt>_<nonce>` equals a
 * given digest. It is not a leading-zeros problem — the whole 32-byte digest
 * must match, so exactly one nonce in the announced range satisfies it and
 * the work is bounded by that range.
 *
 * The hash is **SHA3-256's sponge with 23 Keccak rounds instead of 24**. That
 * is the entire difference, and it is why `node:crypto` cannot be used for
 * it: the platform gives 24.
 *
 * Everything is 32-bit rather than BigInt: a difficulty of 250 000 means
 * 250 000 permutations, and BigInt lanes make that roughly two orders of
 * magnitude slower for no benefit.
 *
 * Ported from the previous project's `deepseek-pow.ts`. The BigInt "readable
 * model" that used to sit beside this code is not carried over: the fast path
 * is parameterised by round count, so checking it against the platform at 24
 * rounds is what keeps the 23-round version honest — the same check the
 * readable model was there to make possible.
 */
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
const HEX_DIGITS = "0123456789abcdef";

/** The same permutation in 32-bit words. Each 64-bit lane is adjacent little-endian words. */
function keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, roundCount) {
  const firstRound = ROUND_CONSTANTS.length - roundCount;
  for (let round = firstRound; round < ROUND_CONSTANTS.length; round++) {
    for (let x = 0; x < 5; x++) {
      const word = 2 * x;
      columnParity[word] = state[word] ^ state[word + 10] ^ state[word + 20] ^ state[word + 30] ^ state[word + 40];
      columnParity[word + 1] = state[word + 1] ^ state[word + 11] ^ state[word + 21] ^ state[word + 31] ^ state[word + 41];
    }
    for (let x = 0; x < 5; x++) {
      const previous = 2 * ((x + 4) % 5);
      const next = 2 * ((x + 1) % 5);
      const rotatedLow = (columnParity[next] << 1) | (columnParity[next + 1] >>> 31);
      const rotatedHigh = (columnParity[next + 1] << 1) | (columnParity[next] >>> 31);
      thetaMix[2 * x] = columnParity[previous] ^ rotatedLow;
      thetaMix[2 * x + 1] = columnParity[previous + 1] ^ rotatedHigh;
    }
    for (let x = 0; x < 5; x++) {
      const word = 2 * x;
      /**
       * XOR, and it has to be XOR.
       *
       * `|=` is tempting here and is wrong: a lane that already has bits set,
       * XORed with a theta value sharing any of those bits, clears them — OR
       * keeps them. The check against the platform at 24 rounds is what catches
       * this, and it only catches it if this path is the one being checked.
       */
      const low = thetaMix[word];
      const high = thetaMix[word + 1];
      for (const target of [word, word + 10, word + 20, word + 30, word + 40]) {
        state[target] = state[target] ^ low;
        state[target + 1] = state[target + 1] ^ high;
      }
    }

    rhoPiState[0] = state[0];
    rhoPiState[1] = state[1];
    for (let lane = 1; lane < 25; lane++) {
      const source = 2 * lane;
      const destination = RHO_PI_DESTINATION_WORDS[lane];
      const amount = ROTATION_OFFSETS[lane];
      const low = state[source];
      const high = state[source + 1];
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
      const nextWord = CHI_NEXT_WORDS[lane];
      const nextNextWord = CHI_NEXT_NEXT_WORDS[lane];
      state[word] = rhoPiState[word] ^ (~rhoPiState[nextWord] & rhoPiState[nextNextWord]);
      state[word + 1] = rhoPiState[word + 1] ^ (~rhoPiState[nextWord + 1] & rhoPiState[nextNextWord + 1]);
    }
    state[0] = state[0] ^ ROUND_CONSTANTS_LOW[round];
    state[1] = state[1] ^ ROUND_CONSTANTS_HIGH[round];
  }
}

function absorbFullUint32Block(state, bytes, offset, rhoPiState, columnParity, thetaMix, roundCount) {
  for (let index = 0; index < RATE_BYTES; index++) {
    state[index >>> 2] ^= bytes[offset + index] << ((index & 3) * 8);
  }
  keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, roundCount);
}

function digestStateToHex(state) {
  let digest = "";
  for (let index = 0; index < OUTPUT_BYTES; index++) {
    const byte = (state[index >>> 2] >>> ((index & 3) * 8)) & 0xff;
    digest += HEX_DIGITS[byte >>> 4] + HEX_DIGITS[byte & 0x0f];
  }
  return digest;
}

/** SHA3-256's sponge with a selectable round count, in 32-bit words. */
function sha3_256Uint32WithRoundCount(input, roundCount) {
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
    state[index >>> 2] ^= bytes[offset + index] << ((index & 3) * 8);
  }
  state[remaining >>> 2] ^= DOMAIN_SUFFIX << ((remaining & 3) * 8);
  state[(RATE_BYTES - 1) >>> 2] ^= 0x80 << 24;
  keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, roundCount);
  return digestStateToHex(state);
}

/** `DeepSeekHashV1`. */
export function deepSeekHashV1(input) {
  return sha3_256Uint32WithRoundCount(input, DEEPSEEK_HASH_ROUNDS);
}

/**
 * The same sponge at a chosen round count.
 *
 * Exported so the 23-round version can be checked against the platform: at 24
 * rounds this is SHA3-256, and `node:crypto` can say what SHA3-256 is.
 */
export function sha3_256WithRoundCount(input, roundCount) {
  return sha3_256Uint32WithRoundCount(input, roundCount);
}

function parseDigestWords(digestHex) {
  const words = new Uint32Array(OUTPUT_BYTES / 4);
  for (let index = 0; index < OUTPUT_BYTES; index++) {
    const byte = Number.parseInt(digestHex.slice(index * 2, index * 2 + 2), 16);
    words[index >>> 2] |= byte << ((index & 3) * 8);
  }
  return words;
}

/**
 * Finds the nonce, or -1 if the range does not contain one.
 *
 * The prefix is absorbed **once** and the state is copied per candidate, so a
 * 250 000-wide search re-encodes nothing. Inputs are validated here as well as
 * at the solver boundary, so a hostile challenge cannot coerce this into an
 * unbounded loop or an oversized allocation.
 */
export function findDeepSeekPowNonce(prefix, challenge, difficulty) {
  if (typeof prefix !== "string") throw new TypeError("DeepSeek PoW prefix must be a string");
  if (!/^[a-f0-9]{64}$/i.test(challenge)) {
    throw new TypeError("DeepSeek PoW challenge must be a 64-character hex digest");
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
    tailWords[index >>> 2] ^= prefixBytes[prefixOffset + index] << ((index & 3) * 8);
  }

  const targetWords = parseDigestWords(challenge.toLowerCase());
  const state = new Uint32Array(50);

  nonceLoop: for (let nonce = 0; nonce < difficulty; nonce++) {
    state.set(baseState);
    for (let word = 0; word < tailWords.length; word++) state[word] ^= tailWords[word];

    let position = tailLength;
    const nonceText = String(nonce);
    for (let index = 0; index < nonceText.length; index++) {
      state[position >>> 2] ^= nonceText.charCodeAt(index) << ((position & 3) * 8);
      position += 1;
      if (position === RATE_BYTES) {
        keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, DEEPSEEK_HASH_ROUNDS);
        position = 0;
      }
    }
    state[position >>> 2] ^= DOMAIN_SUFFIX << ((position & 3) * 8);
    state[(RATE_BYTES - 1) >>> 2] ^= 0x80 << 24;
    keccakP1600Uint32(state, rhoPiState, columnParity, thetaMix, DEEPSEEK_HASH_ROUNDS);

    for (let word = 0; word < targetWords.length; word++) {
      if (state[word] !== targetWords[word]) continue nonceLoop;
    }
    return nonce;
  }
  return -1;
}

/**
 * Reads the whole body, with a cap.
 */
async function readBodyCapped(response, signal) {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeepSeekWebError("DeepSeek’s answer grew past 8 MB and was cut off.", {
          status: 502,
          code: "PROVIDER_REQUEST_FAILED",
        });
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released after a cancellation.
    }
  }
  return chunks.join("");
}

function errorBody(status, message, type, code) {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The OpenAI-shaped stream, replayed from the decoded answer.
 *
 * The upstream answers with an SSE stream, but the decoder needs the whole
 * body: the `FINISHED` marker arrives last, and a body that closes without it
 * was cut off mid-generation. So the turn is read in full and checked before
 * anything is sent, and the tokens do not arrive one at a time. The previous
 * project made the same trade and did not claim streaming either.
 */
function buildStreamingResponse(answer, model, cid, created) {
  const encoder = new TextEncoder();
  const frame = (delta, finishReason = null) =>
    sseChunk({
      id: cid,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: null,
      choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    });

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frame({ role: "assistant" })));
      if (answer.reasoning) {
        controller.enqueue(encoder.encode(frame({ reasoning_content: answer.reasoning })));
      }
      controller.enqueue(encoder.encode(frame({ content: answer.content })));
      controller.enqueue(encoder.encode(frame({}, "stop")));
      controller.enqueue(encoder.encode(SSE_DONE));
      controller.close();
    },
  });
}

export class DeepSeekWebExecutor extends BaseExecutor {
  constructor() {
    super("deepseek-web", PROVIDERS["deepseek-web"] || deepseekWebEntry.transport);
    /** Keyed by userToken, because the access token is per-account and lasts about an hour. */
    this.accessTokens = new Map();
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return DEEPSEEK_WEB.completionUrl;
  }

  /**
   * The browser-ish headers the web client sends.
   *
   * The bearer credential is *not* here: the pasted `userToken` is exchanged
   * for an access token first, and that token is what the completion call
   * carries. The exchange is per request path, not per header.
   */
  buildHeaders(credentials, stream = true) {
    return deepSeekFingerprintHeaders();
  }

  /**
   * The body the completion endpoint takes.
   *
   * One flat `prompt` rather than a message array, and three flags that come
   * from the model rather than the request. The chat session id and the
   * proof-of-work answer are only known after the two calls before it, so
   * `execute` fills them in.
   */
  transformRequest(model, body, stream, credentials) {
    const spec = lookupDeepSeekWebModel(model);
    const messages = (body?.messages || []).map((message) => ({
      role: String(message?.role || "user"),
      text: messageText(message?.content),
    }));
    return {
      chat_session_id: null,
      parent_message_id: null,
      model_type: spec?.expert ? "expert" : "default",
      prompt: flattenToPrompt(messages),
      ref_file_ids: [],
      thinking_enabled: spec?.thinking === true,
      search_enabled: spec?.search === true,
      preempt: false,
    };
  }

  /**
   * The access token, cached for an hour.
   *
   * The userToken authorises `users/current` and nothing else; that call
   * hands back a short-lived access token for everything else. Cached for an
   * hour because it is the same value for every request in that window, and a
   * turn otherwise spends two round trips before it sends anything.
   *
   * One eviction for the whole flow: whichever of the three mid-flight
   * endpoints answers 401, the cached access token is now known bad and the
   * next attempt must not reuse it.
   */
  async accessToken(userToken, { signal, proxyOptions } = {}) {
    const cached = this.accessTokens.get(userToken);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const token = await fetchDeepSeekAccessToken(userToken, {
      signal,
      fetchImpl: (url, options) => proxyAwareFetch(url, options, proxyOptions),
    });
    // A minute of slack, so a token cannot expire between the check and the request.
    this.accessTokens.set(userToken, { token, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
    return token;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        response: errorBody(400, "Missing or empty messages array", "invalid_request", "invalid_request"),
        url: DEEPSEEK_WEB.completionUrl,
        headers: {},
        transformedBody: body,
      };
    }

    const spec = lookupDeepSeekWebModel(model);
    if (!spec) {
      const message = `DeepSeek Web does not offer a model called ${model}. The models it serves are the ones on this page.`;
      return {
        response: errorBody(400, message, "invalid_request", "not_supported"),
        url: DEEPSEEK_WEB.completionUrl,
        headers: {},
        transformedBody: body,
      };
    }

    let userToken;
    try {
      userToken = parseDeepSeekUserToken(credentials?.apiKey || credentials?.accessToken || "");
    } catch (error) {
      return {
        response: errorBody(
          error?.status || 401,
          error?.message || "This DeepSeek Web connection has no userToken.",
          error?.type || "authentication_error",
          error?.code || "invalid_request",
        ),
        url: DEEPSEEK_WEB.completionUrl,
        headers: {},
        transformedBody: body,
      };
    }

    const payload = this.transformRequest(model, body, stream, credentials);
    const headers = this.buildHeaders(credentials, stream);

    try {
      const accessToken = await this.accessToken(userToken, { signal, proxyOptions });

      const sessionId = await this.createChatSession(accessToken, { signal, proxyOptions });
      const pow = await this.solveProofOfWork(accessToken, { signal, proxyOptions });

      payload.chat_session_id = sessionId;

      const response = await proxyAwareFetch(
        DEEPSEEK_WEB.completionUrl,
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "X-Ds-Pow-Response": pow,
            "X-Client-Timezone-Offset": String(new Date().getTimezoneOffset() * -60),
          },
          body: JSON.stringify(payload),
          ...(signal ? { signal } : {}),
        },
        proxyOptions,
      );

      if (!response.ok) throw deepSeekRefusal(response.status, "answering the completion");

      const answer = decodeDeepSeekAnswer(await readBodyCapped(response, signal));
      if (!answer.content) {
        throw new DeepSeekWebError(
          "DeepSeek answered, but the stream carried no text. Its response format may have changed.",
          { status: 502, code: "PROVIDER_REQUEST_FAILED" },
        );
      }
      /**
       * A body that closes without `response/status: "FINISHED"` was cut off
       * mid-generation — an expired session, a dropped connection, an anti-bot
       * challenge. Reporting the fragment as a complete answer with
       * `finish_reason: stop` is the worst version of this: it looks like a
       * model that finished, and the text is silently missing its ending.
       */
      if (!answer.finished) {
        throw new DeepSeekWebError(
          `DeepSeek's stream ended before it finished generating — the answer was cut off after ${answer.content.length} characters. This is usually a dropped connection or an expired session. Try again.`,
          { status: 502, code: "PROVIDER_REQUEST_FAILED" },
        );
      }

      const cid = `chatcmpl-deepseek-${crypto.randomUUID().slice(0, 12)}`;
      const created = Math.floor(Date.now() / 1000);
      const promptTokens = Math.ceil((payload.prompt?.length || 0) / 4);
      const completionTokens = answer.usage || Math.ceil(answer.content.length / 4);

      if (stream) {
        return {
          response: new Response(buildStreamingResponse(answer, spec.id, cid, created), {
            status: 200,
            headers: { ...SSE_HEADERS_NO_BUFFER },
          }),
          url: DEEPSEEK_WEB.completionUrl,
          headers,
          transformedBody: payload,
        };
      }

      const message = { role: "assistant", content: answer.content };
      if (answer.reasoning) message.reasoning_content = answer.reasoning;
      return {
        response: new Response(
          JSON.stringify({
            id: cid,
            object: "chat.completion",
            created,
            model: spec.id,
            system_fingerprint: null,
            choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        url: DEEPSEEK_WEB.completionUrl,
        headers,
        transformedBody: payload,
      };
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const type = error?.type || "upstream_error";
      const code = error?.code || `HTTP_${status}`;
      /**
       * One eviction for the whole flow: whichever of the three mid-flight
       * endpoints answers 401, the cached access token is now known bad and
       * the next attempt must not reuse it.
       */
      if (status === 401 || status === 403) this.accessTokens.delete(userToken);
      log?.warn?.("DS-WEB", error?.message || String(error));
      return {
        response: errorBody(status, error?.message || "DeepSeek Web failed.", type, code),
        url: DEEPSEEK_WEB.completionUrl,
        headers,
        transformedBody: payload,
      };
    }
  }

  /**
   * Starts a chat session.
   *
   * The endpoint takes a `chat_session_id`, and the id is not optional: a
   * completion without one is refused.
   */
  async createChatSession(accessToken, { signal, proxyOptions } = {}) {
    const response = await proxyAwareFetch(
      DEEPSEEK_WEB.sessionUrl,
      {
        method: "POST",
        headers: {
          ...deepSeekFingerprintHeaders(),
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({}),
        ...(signal ? { signal } : {}),
      },
      proxyOptions,
    );
    if (!response.ok) throw deepSeekRefusal(response.status, "starting a chat session");

    const session = unwrapDeepSeekBizData(await response.json().catch(() => null), "chat session")
      .chat_session;
    if (!session?.id) {
      throw new DeepSeekWebError("DeepSeek started no chat session.", {
        status: 502,
        code: "PROVIDER_REQUEST_FAILED",
      });
    }
    return session.id;
  }

  /**
   * Solves a fresh proof of work for the completion endpoint.
   *
   * A challenge per completion, not per session: the answer is bound to the
   * target path and carries the challenge's own expiry, so caching one would
   * be reusing spent work.
   */
  async solveProofOfWork(accessToken, { signal, proxyOptions } = {}) {
    const response = await proxyAwareFetch(
      DEEPSEEK_WEB.powChallengeUrl,
      {
        method: "POST",
        headers: {
          ...deepSeekFingerprintHeaders(),
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ target_path: DEEPSEEK_WEB.completionPath }),
        ...(signal ? { signal } : {}),
      },
      proxyOptions,
    );
    if (!response.ok) throw deepSeekRefusal(response.status, "issuing a proof of work");

    const challenge = unwrapDeepSeekBizData(
      await response.json().catch(() => null),
      "proof of work",
    ).challenge;
    if (!challenge?.challenge || typeof challenge.salt !== "string" || typeof challenge.difficulty !== "number") {
      throw new DeepSeekWebError("DeepSeek returned a proof-of-work challenge with no answer in it.", {
        status: 502,
        code: "PROVIDER_REQUEST_FAILED",
      });
    }
    if (challenge.algorithm !== undefined && challenge.algorithm !== "DeepSeekHashV1") {
      // A new hash would silently produce a wrong answer, which DeepSeek reports as a plain
      // 401. Saying which algorithm arrived is the difference between a fixable error and a
      // mystery.
      throw new DeepSeekWebError(
        `DeepSeek changed its proof-of-work algorithm to ${challenge.algorithm}; this version solves DeepSeekHashV1.`,
        { status: 502, code: "PROVIDER_REQUEST_FAILED" },
      );
    }

    const prefix = `${challenge.salt}_${challenge.expire_at ?? 0}_`;
    const nonce = findDeepSeekPowNonce(
      prefix,
      challenge.challenge,
      Math.min(challenge.difficulty, MAX_DEEPSEEK_POW_DIFFICULTY),
    );
    if (nonce < 0) {
      throw new DeepSeekWebError(
        `DeepSeek's proof of work had no answer within the range it announced (${challenge.difficulty}). The challenge may have expired before it was solved.`,
        { status: 502, code: "PROVIDER_REQUEST_FAILED" },
      );
    }

    return Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm ?? "DeepSeekHashV1",
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: nonce,
        signature: challenge.signature,
        target_path: challenge.target_path ?? "/api/v2/chat/completion",
      }),
    ).toString("base64");
  }
}

export { DEEPSEEK_WEB_MODELS };
export default DeepSeekWebExecutor;
