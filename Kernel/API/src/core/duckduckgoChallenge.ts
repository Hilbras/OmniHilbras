import { createHash } from 'node:crypto';
import { runInContext, createContext } from 'node:vm';
import { CHALLENGE_STUBS } from './duckduckgoChallengeStubs.js';

/**
 * Solving DuckDuckGo's `x-vqd-hash-1` anti-bot challenge.
 *
 * ## What the challenge is, and why it cannot be skipped
 *
 * `GET /duckchat/v1/status` answers with a base64 blob. Decode it and it is JavaScript which, when run,
 * returns `client_hashes` — but only after deciding it is running in a real browser. Sending the blob back
 * **unsolved** is not a no-op: the live service answers `418 ERR_CHALLENGE`, and the wasted call still counts
 * against the address's anonymous-chat quota. So there are exactly two options, solve it or do not attempt a
 * turn at all, and the second is what the adapter does when the solver cannot produce a hash.
 *
 * ## What is measured, and what is not
 *
 * Measured against the live service from this machine: the challenge is served on every request to
 * `/status`; the ported shims solve it in 3-4 ms across five consecutive variants; and a solved hash
 * produces a real answer (`POST /duckchat/v1/chat` -> 200, `text/event-stream`).
 *
 * **Not** re-measured here, and deliberately left as the source records it: the exact probe list is
 * DuckDuckGo's and changes without notice, so this is a port of something that worked rather than a
 * derivation. `parseDuckDuckGoChallenge` refuses a challenge it cannot decode, and `ask` refuses a turn
 * without a solved hash, so both failure directions are named rather than silent.
 */

/** The four conditions the source recorded for the challenge-response shape; asserted so drift is visible. */
export const CHALLENGE_MARKERS = ['client_hashes', 'server_hashes', 'meta'] as const;

/**
 * `data-version-tag` and `data-version-sha` on the homepage's `<html>`, joined by a hyphen.
 *
 * **The assembled value is the fix, not the regex.** The source looked for `serp_...-<20-40 hex>` as one
 * contiguous string in the homepage HTML and never found it — the tag and the sha are two *attributes* —
 * so it silently fell back to a hardcoded version from an earlier release on every single request. Measured
 * on the live homepage:
 *
 * ```
 * <html ... data-version-tag="serp_20261016_162040_ET" data-version-sha="69b477...">
 * ```
 *
 * Kept here rather than in the driver because it is a fact about the page, and `duckduckgo-challenge.test.js`
 * pins both the assembly and the refusal when either attribute is missing — a stale version is worse than no
 * version, because it looks like a measurement.
 */
export function duckDuckGoFeVersion(homeHtml: string): string | undefined {
  const tag = /data-version-tag="([^"]+)"/.exec(homeHtml)?.[1];
  const sha = /data-version-sha="([^"]+)"/.exec(homeHtml)?.[1];
  if (!tag || !sha) return undefined;
  return `${tag}-${sha}`;
}

/** `sha256` in base64, which is the encoding the challenge's own hashes use. */
export function sha256Base64(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64');
}

/**
 * The telemetry the real client sends as `x-fe-signals`.
 *
 * A base64 JSON timeline of made-up interaction timings. The spike sent one on every request that succeeded
 * and never sent a request without one, so it is carried — recorded as *"the set that returned 200"* rather
 * than as a proven minimum, because proving it would cost a chat POST against a rate-limited endpoint.
 */
export function duckDuckGoFeSignals(now: number = Date.now()): string {
  const start = now - 3000;
  let elapsed = 80 + Math.floor(Math.random() * 101);
  const events: Array<{ type: string; ts: number; data?: unknown }> = [];
  for (const type of ['mousemove', 'scroll', 'keydown', 'mousemove', 'scroll']) {
    events.push({ type, ts: start + elapsed });
    elapsed += 40 + Math.floor(Math.random() * 221);
  }
  const signals = {
    start,
    duration: elapsed,
    events,
    meta: { origin: 'https://duck.ai', stack: ['entry.duckai.js'], duration: String(elapsed) },
  };
  return Buffer.from(JSON.stringify(signals), 'utf8').toString('base64');
}

/** A 32-hex journey id, which is what the real client sends as `x-ddg-journey-id`. */
export function duckDuckGoJourneyId(): string {
  return createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32);
}

export type DuckDuckGoChallengeSolution = {
  /** The base64 `x-vqd-hash-1` value to send. */
  header: string;
  /** How long the challenge took to run. Recorded because a solver that suddenly takes 4 s is a symptom. */
  elapsedMs: number;
};

/**
 * Run the served challenge against the shims and return the header value.
 *
 * The two substitutions are the per-request inputs the challenge reads: the user agent it is asked about,
 * and the HTML literals it harvests. `__DDG_HTML_LOOKUP__` is `{}` in practice — four measured variants
 * contained no HTML literal the source's harvest regex matched — which is why the port dropped the source's
 * `parse5` dependency rather than keeping a parser for a corpus that is empty.
 */
export async function solveDuckDuckGoChallenge(
  challenge: string,
  userAgent: string,
  options: { origin?: string; bundlePath?: string; timeoutMs?: number } = {},
): Promise<DuckDuckGoChallengeSolution> {
  let source: string;
  /**
   * The base64 is checked for **shape** before it is decoded, because `Buffer.from(x, 'base64')` is lenient:
   * it drops characters it does not recognise rather than failing, so a malformed challenge sailed into the
   * `vm` and came back as `SyntaxError: Invalid or unexpected token` — an unnamed failure on a path where
   * discovering it costs anonymous-chat quota. Measured before this check existed. Refusing by name is the
   * point: the caller can then say what happened instead of "the challenge failed".
   */
  const trimmed = challenge.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('the challenge was not base64');
  }
  try {
    source = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    throw new Error('the challenge was not decodable');
  }
  if (!source.trim()) throw new Error('the challenge decoded to nothing');

  const timeoutMs = options.timeoutMs ?? 5_000;
  const stubs = CHALLENGE_STUBS.replace('__DDG_REAL_UA__', JSON.stringify(userAgent)).replace('__DDG_HTML_LOOKUP__', '{}');

  const context = createContext({});
  // The shims first: they define the environment the challenge probes for.
  runInContext(stubs, context, { timeout: timeoutMs });

  const startedAt = Date.now();
  const result = (await runInContext(source, context, { timeout: timeoutMs })) as {
    client_hashes?: unknown;
    meta?: Record<string, unknown>;
  };
  const elapsedMs = Date.now() - startedAt;

  const clientHashes = Array.isArray(result?.client_hashes) ? result.client_hashes : [];
  if (clientHashes.length === 0) throw new Error('the challenge returned no client hashes');
  for (const marker of CHALLENGE_MARKERS) {
    if (!(marker in (result ?? {}))) throw new Error(`the challenge response has no ${marker}`);
  }

  const origin = options.origin ?? 'https://duck.ai';
  const bundlePath = options.bundlePath ?? '/dist/duckai-dist/entry.duckai.js';
  const meta = (result.meta ?? {}) as Record<string, unknown>;

  const solved = {
    ...result,
    client_hashes: clientHashes.map((hash) => sha256Base64(String(hash))),
    meta: {
      ...meta,
      // The three fields the source recorded as *required*: without them the service answers 418 "even when
      // every client_hash is correct". Their values are not compared against anything — the probes are
      // presence checks — so they describe this gateway rather than impersonating a browser exactly.
      origin,
      stack: [`${origin}${bundlePath}`],
      duration: String(elapsedMs),
    },
  };

  return { header: Buffer.from(JSON.stringify(solved), 'utf8').toString('base64'), elapsedMs };
}