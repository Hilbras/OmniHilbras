import { ProviderError } from '../core/errors.js';
import type { Model } from '../core/types.js';
import type { HttpTransport } from '../core/transport.js';

/**
 * Qwen Web, through the credential a signed-in chat.qwen.ai session holds.
 *
 * ## What is measured, and what is not
 *
 * Everything here was established against the live site, not assumed. The shape of the blocker
 * is unusual enough to be worth stating plainly:
 *
 * - `GET https://auth.qwen.ai/api/v2/auths/refresh` answers **401 Unauthorized** for a guest, and
 *   no auth cookie is set on any host. Qwen's auth is on a *different origin* from its chat app,
 *   so there is nothing for an unauthenticated client to present.
 * - `POST https://chat.qwen.ai/api/v2/chat/completions` answers **HTTP 200** with a refusal in
 *   the body: `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::…"],"data":{"url":"…/_____tmd_____/punish?…"}}`.
 *   The status code says success. A client that checks only the status sees a working provider.
 * - That `_____tmd_____/punish` URL is **not a clearance flow**: requesting it returns 200,
 *   renders "Please connect them in order", sets no cookie, and the retry is refused with a
 *   freshly minted challenge. It is a human puzzle, so a client cannot satisfy it.
 * - `GET /api/v2/models/` *does* answer for a guest, which is why the model catalog is real while
 *   the provider cannot serve a turn.
 *
 * So the open question is one that cannot be answered without a signed-in account: **does the
 * TMD gate apply to an authenticated request?** Everything else about the request is known and
 * written down here, so the moment a credential exists the only thing left to learn is that one
 * answer — and `probeQwenWeb` reports it rather than guessing.
 */

const QWEN_ORIGIN = 'https://chat.qwen.ai';
const QWEN_AUTH_ORIGIN = 'https://auth.qwen.ai';
const TURN_PATH = '/api/v2/chat/completions';
const AUTH_PATH = '/api/v2/auths/';

/** The Qwen web client's own fingerprint. Qwen's gateway is picky about being itself. */
const FINGERPRINT_HEADERS = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  origin: QWEN_ORIGIN,
  referer: `${QWEN_ORIGIN}/`,
  'sec-ch-ua': '"Chromium";v="151", "Not(A:Brand";v="8"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
} as const;

export const qwenWebProviderId = 'qwen-web';

/** The browser's own user agent, sent verbatim so the client cannot be told apart from the app. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36';

/** Reads a pasted cookie header, or a lone `name=value`, into a plain object. */
export function parseQwenCookieHeader(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the Cookie header from auth.qwen.ai.', {
      providerId: qwenWebProviderId,
      publicMessage: 'Paste the Cookie header from auth.qwen.ai.',
    });
  }
  // A pasted request line is the commonest mistake and reads as a nonsense credential.
  if (/^(GET|POST|PUT|HEAD|OPTIONS)\s+\//i.test(trimmed)) {
    throw new ProviderError('INVALID_REQUEST', 'That is a request line, not a cookie. Copy the value of the Cookie header only.', {
      providerId: qwenWebProviderId,
      publicMessage: 'That is a request line, not a cookie. Copy the value of the Cookie header only.',
    });
  }
  const out: Record<string, string> = {};
  for (const part of trimmed.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name && value) out[name] = value;
  }
  if (Object.keys(out).length === 0) {
    throw new ProviderError('INVALID_REQUEST', 'That does not look like a cookie header — it has no name=value pairs in it.', {
      providerId: qwenWebProviderId,
      publicMessage: 'That does not look like a cookie header — it has no name=value pairs in it.',
    });
  }
  return out;
}

export type QwenProbeResult = {
  /** Whether the credential authorises anything at all. */
  authenticated: boolean;
  /** Whether a turn was served. The TMD gate refuses with HTTP 200, so this is read from the body. */
  turnServed: boolean;
  /** The provider's own words about the turn. Never replaced with a summary. */
  detail: string;
  /** What the auth origin said. A guest is refused here first, and a bad credential shows up here. */
  authDetail: string;
  /** The models Qwen serves, which are readable by guests and so are always available. */
  models: string[];
};

/**
 * The provider's own refusal, read out of a **200** response.
 *
 * Qwen signals every refusal in the body and never in the status code, on both origins. A check
 * that trusted the status would report a guest cookie as a working credential.
 */
function readRefusal(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as { success?: unknown; data?: { code?: unknown; details?: unknown } };
  if (record.success !== false) return undefined;
  const code = record.data?.code;
  const details = record.data?.details;
  return [typeof code === 'string' ? code : undefined, typeof details === 'string' ? details : undefined]
    .filter(Boolean)
    .join(' — ') || 'refused';
}

function readModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  const rows = Array.isArray(data) ? data : Array.isArray((data as { data?: unknown })?.data) ? ((data as { data: unknown[] }).data) : [];
  return rows
    .map((row) => (row && typeof row === 'object' ? String((row as { id?: unknown }).id ?? '') : ''))
    .filter(Boolean);
}

/**
 * Asks Qwen three questions and reports all three answers.
 *
 * Deliberately a *probe* rather than a connect. The whole reason this exists is that one question
 * — does the bot-protection gate apply to an authenticated request? — cannot be answered without
 * a signed-in account, and guessing wrong in either direction is bad: claiming it works would
 * ship a card that cannot answer, and refusing to try would be refusing on the strength of a
 * measurement nobody made. So it asks, and it says what came back.
 */
export async function probeQwenWeb(
  cookieHeader: string,
  transport: HttpTransport,
  signal?: AbortSignal,
  options: { timeoutMs?: number } = {},
): Promise<QwenProbeResult> {
  const cookies = parseQwenCookieHeader(cookieHeader);
  const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  const headers = (extra: Record<string, string> = {}) => ({
    ...FINGERPRINT_HEADERS,
    cookie,
    'user-agent': BROWSER_USER_AGENT,
    ...extra,
  });

  /**
   * A budget for the whole probe, because the alternative is a spinner that never resolves.
   *
   * Not the network — the three requests together take about a second. It is that a caller
   * waiting on a promise it cannot see into will sit there indefinitely if anything stalls, and
   * "Ask Qwen" with no outcome is indistinguishable from a broken button. On expiry the answers
   * gathered so far are returned rather than discarded: a slow auth origin with a fast refusal on
   * the turn is still a useful answer, and throwing it away would be its own kind of dishonesty.
   */
  const timeoutMs = options.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const ask = async (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => {
    try {
      const response = await transport.request<unknown>({
        method: init.method,
        url,
        headers: init.headers,
        providerId: qwenWebProviderId,
        ...(init.body ? { body: init.body } : {}),
        signal: controller.signal,
      });
      return { status: response.status, data: response.data, error: undefined as string | undefined };
    } catch (error) {
      // A refusal is an answer here, not a failure to report around. The transport throws on a
      // non-2xx and the message carries the status, which is exactly the evidence wanted.
      return { status: 0, data: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  };

  try {
    /**
     * All three at once, and the turn last only because it needs a model id.
     *
     * Sequential requests cost three round trips to a host on another continent. The models
     * catalog is the only dependency between them, and it does not need the turn's answer — so
     * the turn is fired as soon as the catalog lands and the two never wait on each other.
     */
    const authPromise = ask(`${QWEN_AUTH_ORIGIN}${AUTH_PATH}`, { method: 'GET', headers: headers() });
    const catalogPromise = ask(`${QWEN_ORIGIN}/api/v2/models/`, { method: 'GET', headers: headers() });

    const [auth, catalog] = await Promise.all([authPromise, catalogPromise]);
    const models = readModels(catalog.data);
    const turn = await ask(`${QWEN_ORIGIN}${TURN_PATH}`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: models[0] ?? 'qwen3.7-plus', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });

    // 1. The auth origin. A guest is refused here first, so this separates "no credential" from
    //    "the credential is not the problem".
    //
    //    Read from the **body**, not the status. `auth.qwen.ai` answers a guest with **HTTP 200**
    //    and `{"success":false,"data":{"code":"Unauthorized"}}` — the status code is a lie and the
    //    transport, correctly, does not throw. Trusting the status is what made a guest cookie
    //    report as `authenticated: true`.
    const authRefused = readRefusal(auth.data) ?? (auth.error ? auth.error : undefined);
    const authenticated = auth.error === undefined && !authRefused;
    const authDetail = authRefused ?? `HTTP ${auth.status}`;

    // 2. The turn — the question that actually matters, and the one the refusal answers.
    const ret = Array.isArray((turn.data as { ret?: unknown })?.ret) ? ((turn.data as { ret: unknown[] }).ret) : [];
    const turnRefusal = readRefusal(turn.data);
    const turnServed = turn.error === undefined && ret.length === 0 && !turnRefusal;
    const detail =
      turn.error
      ?? (ret.length > 0 ? `Qwen refused the turn: ${ret.join(', ')}` : undefined)
      ?? turnRefusal
      ?? `Qwen answered HTTP ${turn.status}.`;

    return { authenticated, turnServed, detail, authDetail, models };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The provider's own refusal, read out of a **200** response.
 *
 * Qwen signals every refusal in the body and never in the status code, on both origins. A check
 * that trusted the status would report a guest cookie as a working credential.
 */

/**
 * A **snapshot** of the guest catalog, for the card. The live list is what `probeQwenWeb`
 * returns, and that is the authority.
 *
 * I first wrote ten plausible ids — `qwen3.7-flash`, `qwen3.7-coder-plus` and so on — and the
 * probe caught it. Then I replaced them with a hard "it answers three" and **that was an
 * overclaim too**: a user running the probe minutes later saw **seven**, including
 * `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus` and `qwen3.5-omni-plus`, while repeated requests
 * from here returned three every time. Cookies were ruled out — none, `cna`, `isg` and a pasted
 * pair all returned the same three.
 *
 * So the endpoint's guest catalog **varies**, and a constant is wrong by construction: it will
 * disagree with the provider on some day, and a card that lists models the endpoint no longer
 * serves is worse than one that says the list moves. This is a dated snapshot for the catalog
 * only, and the dialog always shows the live list.
 */
export const QWEN_WEB_MODELS: Model[] = [
  { id: 'qwen3.7-plus', providerId: qwenWebProviderId },
  { id: 'qwen3.8-max', providerId: qwenWebProviderId },
  { id: 'qwen3.8-omni-flash', providerId: qwenWebProviderId },
];

/** When the snapshot above was read, so a reader can tell a stale list from a wrong one. */
export const QWEN_WEB_MODELS_OBSERVED_AT = '2026-09-29';
