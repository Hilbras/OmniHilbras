import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { DuckDuckGoWebDriver, DuckDuckGoWebPublicKey } from '@hilbras/omnihilbras';
import { DUCKDUCKGO_WEB, DuckDuckGoWebError, duckDuckGoWebContent, parseDuckDuckGoWebDataLine } from '@hilbras/omnihilbras';
import { duckDuckGoFeSignals, duckDuckGoFeVersion, duckDuckGoJourneyId, solveDuckDuckGoChallenge } from './duckduckgoChallenge.js';

/**
 * Duck.ai, driven over HTTP.
 *
 * ## What this file is, and what it is not
 *
 * It is not a browser driver, unlike `geminiWeb.ts` and `chatgptWeb.ts`. `duck.ai`'s chat is a JSON/SSE
 * endpoint, so the only thing standing between this gateway and an answer is an anti-bot challenge — solved
 * with `node:vm`, which is why this half is in the gateway rather than the SDK.
 *
 * ## Measured, once, by hand, before any of this was written
 *
 * `POST /duckchat/v1/chat` -> **200**, `text/event-stream`, and the answer that was asked for, on the first
 * attempt, from this host. Three things that measurement settled and this file depends on:
 *
 * - **The delta is in `message`.** `content` never appears. A reader looking for `content` gets a 200 with an
 *   empty answer — which is why the extraction lives in the SDK and is tested there.
 * - **`x-fe-version` must be assembled** from `data-version-tag` and `data-version-sha`. The source
 *   implementation searched for the joined string, never found it, and sent a hardcoded version from an
 *   earlier release on every request. `duckDuckGoFeVersion` builds it; a page missing either attribute
 *   **refuses the turn**, because a stale version is worse than none — it looks like a measurement.
 * - **418 is not one thing.** A `418 ERR_CHALLENGE` arrived 43 s after a successful turn, with a
 *   byte-identical request, and the same request succeeded 4.9 min later. The leading explanation is a short
 *   per-address quota rather than a solver fault, and the consequence is behavioural: **back off, do not
 *   retry.** The source's "retry once with a fresh challenge" spends a second call against whatever just
 *   refused the first.
 *
 * ## Not established, and not claimed
 *
 * - Whether `reasoningEffort` is strictly required. The source records a 400 without it, verified on its side;
 *   re-measuring costs a chat POST, so the requests that succeeded are the evidence and they all sent it.
 * - Whether the rotated `x-vqd-hash-1` on a chat response is reusable. **Not implemented**: a fresh challenge
 *   is fetched per turn, which costs one extra GET and cannot be wrong.
 * - Which headers are strictly necessary. Ablating them costs chat POSTs, so this sends the set that returned
 *   200 and says so rather than implying it is minimal.
 */

/**
 * The headers the real client sends, minus the ones it does not need.
 *
 * The same-origin triplet (`host` + `Origin` + `Referer`, all `duck.ai`) is the part the source records as
 * load-bearing: a *mixed* triplet — a `duck.ai` host with a `duckduckgo.com` origin — is what it measured
 * returning HTTP 400. The `Sec-*` and `Priority` headers are browser fidelity; the browser-only
 * `x-duckai-*` headers the page's own bundle sends were measured as **not** required, so they are absent.
 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Origin: DUCKDUCKGO_WEB.origin,
    Pragma: 'no-cache',
    Referer: `${DUCKDUCKGO_WEB.origin}/`,
    Priority: 'u=1, i',
    'Sec-Ch-Ua': '"Chromium";v="149", "Not-A.Brand";v="24", "Google Chrome";v="149"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Linux"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': DUCKDUCKGO_WEB.userAgent,
    ...extra,
  };
}

/**
 * The cookies a first visit sets, seeded so a fresh jar is not an empty one.
 *
 * Typed `as const` deliberately: an array literal of arrays infers as `string[][]`, and with
 * `noUncheckedIndexedAccess` every destructured value is then `string | undefined` — which is how a seed list
 * turns into a null cookie without anything failing loudly.
 */
const SEEDED_COOKIES = [
  ['5', '1'],
  ['ah', 'wt-wt'],
  ['dcs', '1'],
  ['dcm', '3'],
  ['isRecentChatOn', '1'],
] as const;

/** A cookie jar that keeps only what the service sets, so redirects and cookie-rotation survive a turn. */
function cookieJar(seed?: string) {
  const jar = new Map<string, string>();
  /**
   * The seeded cookies are what the real page carries before it signs anything.
   *
   * Sending them is deliberate rather than incidental: they are the difference between a fresh jar and no jar
   * at all for a request that arrives at a service which sets them itself. The source implementation seeds the
   * same five.
   */
  for (const [name, value] of SEEDED_COOKIES) {
    jar.set(name, value);
  }
  if (seed) {
    for (const pair of seed.split(';')) {
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  return {
    header: (): string | undefined => (jar.size === 0 ? undefined : [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')),
    remember(response: Response) {
      for (const value of response.headers.getSetCookie?.() ?? []) {
        const pair = value.split(';')[0] ?? '';
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
  };
}

/**
 * A response that is not 200, classified by **kind**.
 *
 * The classification reads the JSON body's `type` field, not its prose. The service's own client maps
 * `ERR_CHALLENGE` and `ERR_BN_LIMIT` to the same user-facing message token, so a regex over the message would
 * conflate an expired challenge with an address-level refusal — and only one of those is worth waiting out.
 */
async function refusal(response: Response): Promise<DuckDuckGoWebError> {
  const body = await response.text().catch(() => '');
  let type = '';
  let overrideCode: string | undefined;
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { type?: unknown; overrideCode?: unknown; message?: unknown };
    type = typeof parsed.type === 'string' ? parsed.type : '';
    overrideCode = typeof parsed.overrideCode === 'string' ? parsed.overrideCode : undefined;
    detail = typeof parsed.message === 'string' ? parsed.message : '';
  } catch {
    detail = body.slice(0, 200);
  }

  // The override code is in the message as well as on the error, because it is the one identifier a support
  // question needs and the one a log line would otherwise lose.
  const summary = `${response.status}${type ? ` ${type}` : ''}${overrideCode ? ` (overrideCode ${overrideCode})` : ''}${detail ? `: ${detail}` : ''}`;
  if (type === 'ERR_BN_LIMIT') return new DuckDuckGoWebError('quota', summary, overrideCode);
  if (type === 'ERR_RATE_LIMIT') return new DuckDuckGoWebError('rate-limit', summary, overrideCode);
  // Everything else at 418, and a bare 418, is the challenge: measured, and the only retry-free reading that
  // is safe, because the alternative is spending another call to learn the same thing.
  if (response.status === 418 || type === 'ERR_CHALLENGE') return new DuckDuckGoWebError('challenge', summary, overrideCode);
  if (response.status === 400 || response.status === 422) return new DuckDuckGoWebError('bad-request', summary, overrideCode);
  return new DuckDuckGoWebError('unavailable', summary, overrideCode);
}

/** The RSA public key the body carries. Generated here because `node:crypto` may not enter the SDK. */
function publicKeyJwk(): DuckDuckGoWebPublicKey {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n?: string; e?: string };
  return { ...jwk, alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'], use: 'enc' };
}

/** `fetch` with a deadline, because a stalled stream otherwise hangs the turn until the process ends. */
async function fetchWithTimeout(doFetch: typeof fetch, url: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('the request timed out')), init.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  try {
    return await doFetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SDK's driver interface, over HTTP.
 *
 * `fetch` is an option so the tests can drive every path — including the 418 the live service only sends when
 * it feels like it — without spending rate budget on the real endpoint.
 */
export function createDuckDuckGoWebDriver(options: { fetch?: typeof fetch } = {}): DuckDuckGoWebDriver {
  const doFetch = options.fetch ?? fetch;

  return {
    async available() {
      // A `vm` is part of Node, so this cannot fail in practice. Reported rather than assumed, because the
      // alternative — discovering it inside a turn — spends a request to find out.
      return { ok: true };
    },

    async catalog({ timeoutMs = DUCKDUCKGO_WEB.catalogTimeoutMs, signal } = {}) {
      // No VQD, no challenge, no credential: the one endpoint this service leaves open. It is also why the
      // model list can be read before anything is spent.
      const response = await fetchWithTimeout(doFetch, `${DUCKDUCKGO_WEB.origin}${DUCKDUCKGO_WEB.modelsPath}`, {
        headers: headers({ Accept: 'application/json' }),
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await refusal(response);
      return (await response.json()) as unknown;
    },

    async status({ timeoutMs = DUCKDUCKGO_WEB.statusTimeoutMs, signal } = {}) {
      const response = await fetchWithTimeout(doFetch, `${DUCKDUCKGO_WEB.origin}${DUCKDUCKGO_WEB.statusPath}`, {
        headers: headers({ 'x-vqd-accept': '1' }),
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await refusal(response);
      const challenge = response.headers.get('x-vqd-hash-1');
      if (!challenge) {
        // No challenge is reported, not thrown: it means the service decided this request needs no proof,
        // which is a fact about the request rather than a failure.
        return { challengeServed: false, solvedMs: 0 };
      }
      const solved = await solveDuckDuckGoChallenge(challenge, DUCKDUCKGO_WEB.userAgent);
      return { challengeServed: true, solvedMs: solved.elapsedMs };
    },

    async ask({ cookieHeader, model, messages, timeoutMs, signal }) {
      const jar = cookieJar(cookieHeader);

      /**
       * The version token, from the homepage.
       *
       * Read per turn rather than cached: it changes with every front-end deploy, and a stale one is the exact
       * defect the source implementation shipped for its whole life.
       */
      const home = await fetchWithTimeout(doFetch, `${DUCKDUCKGO_WEB.origin}${DUCKDUCKGO_WEB.homePath}`, {
        headers: headers(cookieHeader ? { Cookie: cookieHeader } : {}),
        timeoutMs: DUCKDUCKGO_WEB.homeTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (!home.ok) throw await refusal(home);
      // The response is read for two attributes only, so it is not kept. `remember` still runs, because the
      // session cookies a first visit sets are part of what a browser would carry into the next request.
      jar.remember(home);
      const feVersion = duckDuckGoFeVersion(await home.text());
      if (!feVersion) {
        throw new DuckDuckGoWebError(
          'unavailable',
          'the homepage carried no data-version-tag/data-version-sha pair, so the request version could not be assembled',
        );
      }

      const status = await fetchWithTimeout(doFetch, `${DUCKDUCKGO_WEB.origin}${DUCKDUCKGO_WEB.statusPath}`, {
        headers: headers({ 'x-vqd-accept': '1', ...(jar.header() ? { Cookie: jar.header() as string } : {}) }),
        timeoutMs: DUCKDUCKGO_WEB.statusTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (!status.ok) throw await refusal(status);
      jar.remember(status);

      const challenge = status.headers.get('x-vqd-hash-1');
      if (!challenge) {
        throw new DuckDuckGoWebError('challenge', 'the service served no anti-bot challenge, so a turn cannot be proven');
      }
      const solved = await solveDuckDuckGoChallenge(challenge, DUCKDUCKGO_WEB.userAgent);

      const payload = {
        model,
        metadata: { toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false } },
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        canUseTools: true,
        reasoningEffort: DUCKDUCKGO_WEB.defaultReasoningEffort,
        canUseApproxLocation: null,
        canDelegateImageGeneration: null,
        durableStream: { messageId: randomUUID(), conversationId: randomUUID(), publicKey: publicKeyJwk() },
      };

      const response = await fetchWithTimeout(doFetch, `${DUCKDUCKGO_WEB.origin}${DUCKDUCKGO_WEB.chatPath}`, {
        method: 'POST',
        headers: headers({
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'x-ddg-journey-id': duckDuckGoJourneyId(),
          'x-fe-signals': duckDuckGoFeSignals(),
          'x-fe-version': feVersion,
          // Sent solved, always. An unsolved value is answered with 418 and still counts against the quota,
          // so there is no path here that forwards the raw challenge.
          'x-vqd-hash-1': solved.header,
          ...(jar.header() ? { Cookie: jar.header() as string } : {}),
        }),
        body: JSON.stringify(payload),
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw await refusal(response);

      /**
       * The stream is read as text rather than through a browser EventSource, because the frames are plain
       * `data: ` lines and the whole answer is handed back at once — this adapter does not claim to stream.
       *
       * `[CHAT_TITLE:...]` arrives first and is not JSON, so it is dropped rather than allowed to throw: a
       * parser that failed on the first line would fail every turn at its first byte.
       */
      const raw = await response.text();
      let answer = '';
      let answered = model;
      for (const line of raw.split('\n')) {
        const event = parseDuckDuckGoWebDataLine(line);
        if (!event) continue;
        if (typeof event.model === 'string' && event.model) answered = event.model;
        answer += duckDuckGoWebContent(event);
      }
      // A 200 with no text is not success. The service says `{"action":"success","message":"OK"}` before the
      // answer, so a reader that returns early on the first frame reports an empty answer as a completed turn.
      if (!answer) {
        throw new DuckDuckGoWebError('unavailable', 'the service answered 200 with no text in the stream', response.status === 200 ? 'EMPTY_STREAM' : undefined);
      }
      return { text: answer, model: answered };
    },
  };
}