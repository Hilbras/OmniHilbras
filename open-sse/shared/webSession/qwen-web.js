import { browserFingerprintHeaders, cookieHeaderFrom, parseCookieHeader, readBodyRefusal } from "./common.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

/**
 * Qwen Web — the credential a signed-in chat.qwen.ai session holds.
 *
 * Ported from the previous project's `providers/qwen-web`, whose comments carried
 * the measurements that decided the behaviour. The shape of the blocker is unusual
 * enough to be worth stating plainly:
 *
 * - `GET https://auth.qwen.ai/api/v2/auths/refresh` answers **401 Unauthorized** for a
 *   guest, and no auth cookie is set on any host. Qwen's auth is on a *different
 *   origin* from its chat app, so there is nothing for an unauthenticated client to
 *   present.
 * - `POST https://chat.qwen.ai/api/v2/chat/completions` answers **HTTP 200** with a
 *   refusal in the body: `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::…"],
 *   "data":{"url":"…/_____tmd_____/punish?…"}}`. The status code says success. A
 *   client that checks only the status sees a working provider.
 * - That `_____tmd_____/punish` URL is **not a clearance flow**: requesting it
 *   returns 200, renders "Please connect them in order", sets no cookie, and the
 *   retry is refused with a freshly minted challenge. It is a human puzzle, so a
 *   client cannot satisfy it.
 * - `GET /api/v2/models/` *does* answer for a guest, which is why the model catalog
 *   is real while the provider cannot serve a turn.
 *
 * So the open question is one that cannot be answered without a signed-in account:
 * **does the TMD gate apply to an authenticated request?** Everything else about the
 * request is known and written down here, so the moment a credential exists the only
 * thing left to learn is that one answer — and the probe reports it rather than
 * guessing.
 */

/** The provider's endpoints. One place, so the executor's registry entry and this probe agree. */
export const QWEN_ENDPOINTS = {
  origin: "https://chat.qwen.ai",
  authOrigin: "https://auth.qwen.ai",
  authPath: "/api/v2/auths/",
  modelsPath: "/api/v2/models/",
  turnPath: "/api/v2/chat/completions",
};

const QWEN_ORIGIN = QWEN_ENDPOINTS.origin;
const QWEN_AUTH_ORIGIN = QWEN_ENDPOINTS.authOrigin;

/**
 * A budget for the whole probe, because the alternative is a spinner that never
 * resolves.
 *
 * Not the network — the three requests together take about a second. It is that a
 * caller waiting on a promise it cannot see into will sit there indefinitely if
 * anything stalls, and "Ask Qwen" with no outcome is indistinguishable from a
 * broken button. On expiry the answers gathered so far are returned rather than
 * discarded: a slow auth origin with a fast refusal on the turn is still a useful
 * answer, and throwing it away would be its own kind of dishonesty.
 */
const PROBE_TIMEOUT_MS = 20_000;

/** The model the probe turns on when the catalog says nothing. */
const PROBE_FALLBACK_MODEL = "qwen3.7-plus";

/**
 * Reads the pasted credential.
 *
 * The paste is the value of the `Cookie:` header from **auth.qwen.ai** — a whole
 * header value (`name=value; name2=value2`), not one cookie. A pasted request line
 * is the commonest mistake and reads as a nonsense credential, so it is refused with
 * a message that says what to copy.
 */
export function parseQwenCredential(raw) {
  try {
    return parseCookieHeader(raw);
  } catch (err) {
    throw new Error(
      `${err.message} For Qwen, the cookie comes from auth.qwen.ai — its auth is on a different origin from its chat app.`,
    );
  }
}

/** The model ids the catalog endpoint served. */
export function readQwenModels(payload) {
  if (!payload || typeof payload !== "object") return [];
  const data = payload.data;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  return rows.map((row) => (row && typeof row === "object" ? String(row.id ?? "") : "")).filter(Boolean);
}

/**
 * The provider's own refusal, read out of a **200** response.
 *
 * Qwen signals every refusal in the body and never in the status code, on both
 * origins. A check that trusted the status would report a guest cookie as a working
 * credential.
 */
function readAuthRefusal(payload) {
  return readBodyRefusal(payload);
}

/** The turn's refusal, in the wording the previous project used. */
function readTurnRefusal(payload) {
  const ret = Array.isArray(payload?.ret) ? payload.ret : [];
  if (ret.length > 0) return `Qwen refused the turn: ${ret.join(", ")}`;
  const refusal = readBodyRefusal(payload);
  return refusal ? `Qwen refused the turn: ${refusal}` : undefined;
}

/** The bot-protection challenge URL, when the refusal carries one. */
function readGateUrl(payload) {
  const url = payload?.data?.url;
  return typeof url === "string" && url.includes("_____tmd_____/punish") ? url : null;
}

/**
 * Asks Qwen three questions and reports all three answers.
 *
 * Deliberately a *probe* rather than a connect. The whole reason this exists is that
 * one question — does the bot-protection gate apply to an authenticated request? —
 * cannot be answered without a signed-in account, and guessing wrong in either
 * direction is bad: claiming it works would ship a card that cannot answer, and
 * refusing to try would be refusing on the strength of a measurement nobody made.
 * So it asks, and it says what came back.
 */
export async function probeQwenWeb(cookieHeader, { signal, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const pairs = parseQwenCredential(cookieHeader);
  const cookie = cookieHeaderFrom(pairs);

  /**
   * The web app's own fingerprint.
   *
   * Qwen's gateway is picky about being itself, so the request carries the origin,
   * the referer, the sec-ch-ua triplet and the browser's user agent. The auth origin
   * is asked with the same fingerprint as the chat origin, which is what the previous
   * project measured against the live site.
   */
  const headers = (extra = {}) =>
    browserFingerprintHeaders({
      origin: QWEN_ORIGIN,
      referer: `${QWEN_ORIGIN}/`,
      accept: "application/json",
      extra: { cookie, ...extra },
    });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const ask = async (url, { method, body }) => {
    try {
      const response = await proxyAwareFetch(url, {
        method,
        headers: headers(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(body ? { body } : {}),
        signal: controller.signal,
      });
      let data;
      try {
        data = await response.json();
      } catch {
        data = undefined;
      }
      if (!response.ok) {
        // A refusal is an answer here, not a failure to report around: the body
        // carries the reason, and the status alone does not.
        const refusal = data ? readAuthRefusal(data) : undefined;
        return {
          status: response.status,
          data,
          error: `HTTP ${response.status}${refusal ? ` — ${refusal}` : ""}`,
        };
      }
      return { status: response.status, data, error: undefined };
    } catch (error) {
      return { status: 0, data: undefined, error: error?.message || String(error) };
    }
  };

  try {
    /**
     * All three at once, and the turn last only because it needs a model id.
     *
     * Sequential requests cost three round trips to a host on another continent. The
     * models catalog is the only dependency between them, and it does not need the
     * turn's answer — so the turn is fired as soon as the catalog lands and the two
     * never wait on each other.
     */
    const authPromise = ask(`${QWEN_AUTH_ORIGIN}${QWEN_ENDPOINTS.authPath}`, { method: "GET" });
    const catalogPromise = ask(`${QWEN_ORIGIN}${QWEN_ENDPOINTS.modelsPath}`, { method: "GET" });

    const [auth, catalog] = await Promise.all([authPromise, catalogPromise]);
    const models = readQwenModels(catalog.data);
    const turn = await ask(`${QWEN_ORIGIN}${QWEN_ENDPOINTS.turnPath}`, {
      method: "POST",
      body: JSON.stringify({
        model: models[0] ?? PROBE_FALLBACK_MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });

    // 1. The auth origin. A guest is refused here first, so this separates "no
    //    credential" from "the credential is not the problem".
    //
    //    Read from the **body**, not the status. `auth.qwen.ai` answers a guest with
    //    **HTTP 200** and `{"success":false,"data":{"code":"Unauthorized"}}` — the
    //    status code is a lie. Trusting the status is what made a guest cookie report
    //    as `authenticated: true`.
    const authRefused = readAuthRefusal(auth.data) ?? (auth.error ? auth.error : undefined);
    const authenticated = auth.error === undefined && !authRefused;
    const authDetail = authRefused ?? `HTTP ${auth.status}`;

    // 2. The turn — the question that actually matters, and the one the refusal answers.
    const turnRefusal = readTurnRefusal(turn.data);
    const turnServed = turn.error === undefined && !turnRefusal;
    const gate = turnRefusal ? readGateUrl(turn.data) : null;
    const detail =
      turn.error
      ?? (turnRefusal
        ? `${turnRefusal}${gate ? ` The provider answered with a bot-protection challenge (${gate}); requesting it grants no cookie, so this is a puzzle for a person and not a clearance flow.` : ""}`
        : undefined)
      ?? `Qwen answered HTTP ${turn.status}.`;

    return { authenticated, turnServed, detail, authDetail, models };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Check the credential. Asks, reports, and saves nothing.
 *
 * The verdict is the turn, because that is what a connection is for: a credential
 * the provider accepts but cannot use is not a working credential, and the detail
 * says so in the provider's own words. The auth origin's answer travels with it,
 * because "the cookie is wrong" and "the provider is refusing the request" are
 * different problems with different fixes.
 */
export async function checkWebSession(credential) {
  let probe;
  try {
    probe = await probeQwenWeb(credential);
  } catch (err) {
    const message = err?.message || String(err);
    return { ok: false, detail: message, error: message, models: [] };
  }

  const detail = probe.turnServed
    ? `A turn was served. Credential at auth.qwen.ai: ${probe.authDetail}.`
    : `${probe.detail} Credential at auth.qwen.ai: ${probe.authDetail}.`;

  return { ok: probe.turnServed, detail, models: probe.models };
}

/**
 * Connect the credential: normalize the paste, prove it can answer, and hand back
 * the string to store.
 *
 * The bar is **a turn was actually served** — the same bar the card states: "nothing
 * is saved either way until a turn really works". A credential the provider accepts
 * but cannot use is not a connection, it is a card that reads as connected and
 * answers nothing, and the previous project shipped Qwen as check-only for exactly
 * that reason.
 *
 * So a refused turn refuses the save, and the provider's own words come back with
 * it: the bot-protection gate answers HTTP 200 with a refusal in the body, and the
 * only honest answer is the refusal itself.
 */
export async function connectWebSession(credential) {
  let pairs;
  try {
    pairs = parseQwenCredential(credential);
  } catch (err) {
    const message = err?.message || String(err);
    return { ok: false, error: message, detail: message, models: [] };
  }

  let probe;
  try {
    probe = await probeQwenWeb(cookieHeaderFrom(pairs));
  } catch (err) {
    const message = err?.message || String(err);
    return { ok: false, error: message, detail: message, models: [] };
  }

  if (!probe.turnServed) {
    const message = probe.authenticated
      ? `${probe.detail} Nothing is saved until a turn is actually served.`
      : `auth.qwen.ai did not accept the credential (${probe.authDetail}). ${probe.detail}`;
    return { ok: false, error: message, detail: message, models: probe.models };
  }

  return {
    ok: true,
    credential: cookieHeaderFrom(pairs),
    models: probe.models,
    name: "Qwen Web",
  };
}
