import deepseekWebEntry from "../../providers/registry/deepseek-web.js";
import { browserFingerprintHeaders, readBodyRefusal } from "./common.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

/**
 * DeepSeek Web — the credential side of chat.deepseek.com.
 *
 * DeepSeek keeps its session in **localStorage**, not in a cookie, so the
 * credential is one value rather than a header: the `userToken` the web client
 * stores under that key. A copy out of the console is sometimes the bare
 * string and sometimes the `{"value":"…"}` wrapper, and both have to work —
 * that is the difference between "paste it" working and "paste it" working
 * only if you know to unwrap it first.
 *
 * The check and the connect are the same single call: `users/current` is the
 * one endpoint the userToken itself authorises, and it hands back a
 * short-lived access token for everything else. It is cheap (one round trip,
 * no proof of work), which is what makes it worth running on every press of
 * the button.
 *
 * Ported from the previous project's `deepseek-web` provider.
 */

const TRANSPORT = deepseekWebEntry.transport;

/**
 * The endpoints, in one place.
 *
 * The origin is taken from the registry entry, which is where the URL belongs;
 * the paths are the web client's own. The completion endpoint is the registry's
 * `baseUrl`, so there is exactly one place a URL is written down.
 */
const ORIGIN = new URL(TRANSPORT.baseUrl).origin;

export const DEEPSEEK_WEB = {
  origin: ORIGIN,
  apiBase: `${ORIGIN}/api`,
  usersUrl: `${ORIGIN}/api/v0/users/current`,
  sessionUrl: `${ORIGIN}/api/v0/chat_session/create`,
  powChallengeUrl: `${ORIGIN}/api/v0/chat/create_pow_challenge`,
  completionUrl: TRANSPORT.baseUrl,
  /** The path a proof-of-work challenge is bound to, as the upstream sees it. */
  completionPath: "/api/v0/chat/completion",
  /** The localStorage key the web client keeps its session token under. */
  tokenStorageKey: "userToken",
};

/**
 * A failure that already knows how it should be reported.
 *
 * `status` is the HTTP status the caller should answer with, `type` and `code`
 * are the OpenAI-shaped error fields. Carrying them on the error is what keeps
 * a 401 from being reported as a provider outage — see `deepSeekRefusal`.
 */
export class DeepSeekWebError extends Error {
  constructor(message, { status = 502, type = "upstream_error", code = "upstream_error" } = {}) {
    super(message);
    this.name = "DeepSeekWebError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

/**
 * The headers the web client sends on every `/api/v0/*` call.
 *
 * The header set is a bot-detection signal in itself, not decoration: the
 * 2.0.0 web build dropped `X-App-Version` and added `X-Client-Bundle-Id`, so
 * sending the *stale* stamp is itself suspicious. These are the ones the
 * current build sends.
 *
 * `x-hif-leim`, a signed client-attestation token from obfuscated JS, is
 * deliberately omitted — reproducing it means porting that JS, and the
 * completion endpoint does not currently require it. If it ever does, requests
 * will fail with a 401 that says nothing about attestation, which is when to
 * come back to it.
 */
export function deepSeekFingerprintHeaders(extra = {}) {
  return browserFingerprintHeaders({
    origin: DEEPSEEK_WEB.origin,
    referer: `${DEEPSEEK_WEB.origin}/`,
    accept: "*/*",
    extra: {
      "X-Client-Bundle-Id": "com.deepseek.chat",
      "X-Client-Locale": "en-US",
      "X-Client-Platform": "web",
      "X-Client-Version": "2.0.0",
      ...extra,
    },
  });
}

/**
 * Reads the token out of whatever the user pasted.
 *
 * DeepSeek stores it as `{"value":"…"}`, so a copy out of localStorage is
 * sometimes the wrapper and sometimes the bare string. Accepting both is the
 * difference between "paste it" working and "paste it" working only if you
 * know to unwrap it first.
 */
export function parseDeepSeekUserToken(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new DeepSeekWebError("Paste the userToken from chat.deepseek.com.", {
      status: 400,
      type: "invalid_request",
      code: "invalid_request",
    });
  }
  // A pasted request line is the commonest mistake and reads as a nonsense
  // credential, so it is refused with a message that says what to copy.
  if (/^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH)\s+\//i.test(trimmed)) {
    throw new DeepSeekWebError(
      "That is a request line, not a userToken. Copy the value of localStorage's userToken only.",
      { status: 400, type: "invalid_request", code: "invalid_request" },
    );
  }
  if (trimmed.startsWith("{")) {
    /**
     * The wrapper is `{"value":"…","__version":N}` — and **signed out it is
     * `{"value":null}`**, which is exactly what a page that is not signed in
     * stores.
     *
     * Falling through to "treat the raw string as the token" turned that null
     * wrapper into a credential: it looked like a token, it was accepted, and
     * the failure surfaced much later as DeepSeek refusing a session nobody
     * could explain. An empty value is the single most likely thing to be
     * handed here, so it is named rather than passed along.
     */
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not the wrapper at all; a bare token is fine.
      return trimmed;
    }
    if (!parsed || typeof parsed !== "object") return trimmed;
    if (typeof parsed.value === "string" && parsed.value.trim()) return parsed.value.trim();
    // No `value` key at all means this was never the wrapper — some other object, pasted by
    // mistake or from somewhere else. That is not the signed-out state, so it is used as-is
    // rather than being told to sign in.
    if (!("value" in parsed)) return trimmed;
    const message =
      "That userToken is empty, which is what chat.deepseek.com stores when you are not signed in. Open chat.deepseek.com, sign in, and copy it again.";
    throw new DeepSeekWebError(message, {
      status: 401,
      type: "authentication_error",
      code: "empty_user_token",
    });
  }
  return trimmed;
}

/**
 * Turns a non-ok status into the refusal it actually is.
 *
 * Every endpoint in this provider's four-step flow goes through here, because
 * the alternative was the bug this replaces: `users/current` and `completion`
 * mapped 401 to `AUTHENTICATION_FAILED` while `create_pow_challenge` and
 * `chat_session/create` mapped the *same* 401 to `PROVIDER_UNAVAILABLE`. Which
 * branch a user hit therefore depended on whether the access token happened to
 * be cached — invisible state deciding whether a dead session reads as "sign in
 * again" or as "the provider is down".
 *
 * The second mapping is the costly one. A "provider unavailable" is retryable,
 * so the router would fail over to another provider for a session that can
 * never recover, and the dashboard would show a provider outage where the
 * truth is an expired token.
 */
export function deepSeekRefusal(status, what) {
  if (status === 401 || status === 403) {
    return new DeepSeekWebError(
      `DeepSeek refused this session while ${what} (${status}). Sign in to chat.deepseek.com again and export a fresh userToken.`,
      { status, type: "authentication_error", code: `HTTP_${status}` },
    );
  }
  if (status === 429) {
    return new DeepSeekWebError(
      `DeepSeek is rate limiting this session (${status}) while ${what}.`,
      { status, type: "rate_limit_error", code: `HTTP_${status}` },
    );
  }
  return new DeepSeekWebError(`DeepSeek answered ${status} while ${what}.`, {
    status,
    type: "upstream_error",
    code: `HTTP_${status}`,
  });
}

/**
 * DeepSeek wraps every response in `{ code, msg, data: { biz_data } }` and
 * `code !== 0` means trouble.
 *
 * This is DeepSeek's refusal-in-the-body: the status can be 200 while the
 * body says the request was rejected, so the status alone is never the answer.
 */
export function unwrapDeepSeekBizData(payload, what) {
  if (!payload || typeof payload !== "object") {
    throw new DeepSeekWebError(`DeepSeek returned no data for the ${what}.`, {
      status: 502,
      code: "PROVIDER_REQUEST_FAILED",
    });
  }
  // The shared refusal reader, for the shape this gateway sees elsewhere.
  const refusal = readBodyRefusal(payload);
  if (refusal) {
    throw new DeepSeekWebError(`DeepSeek refused the ${what}: ${refusal}`, {
      status: 502,
      code: "PROVIDER_REQUEST_FAILED",
    });
  }
  if (typeof payload.code === "number" && payload.code !== 0) {
    const message =
      (typeof payload.msg === "string" && payload.msg) ||
      payload.data?.biz_msg ||
      `error code ${payload.code}`;
    throw new DeepSeekWebError(`DeepSeek rejected the ${what}: ${message}`, {
      status: 502,
      code: "PROVIDER_REQUEST_FAILED",
    });
  }
  const biz = payload.data?.biz_data;
  if (!biz || typeof biz !== "object") {
    throw new DeepSeekWebError(`DeepSeek returned no data for the ${what}.`, {
      status: 502,
      code: "PROVIDER_REQUEST_FAILED",
    });
  }
  return biz;
}

/**
 * Exchanges the userToken for a short-lived access token.
 *
 * The userToken authorises this call and nothing else. Sending it at the
 * completion endpoint gets a 401 that looks like an expired session.
 *
 * No caching here: a cache makes a check cheap but meaningless — the dashboard
 * reported "healthy in 0 ms" from a cache entry that proved nothing, which is
 * the same fault as every other confident unverified answer in this area. The
 * point of a health check is to learn whether the credential works *now*, so
 * the caller that wants a cache keeps one.
 */
export async function fetchDeepSeekAccessToken(userToken, { signal, fetchImpl } = {}) {
  const doFetch = fetchImpl || proxyAwareFetch;
  let response;
  try {
    response = await doFetch(DEEPSEEK_WEB.usersUrl, {
      method: "GET",
      headers: {
        ...deepSeekFingerprintHeaders(),
        Authorization: `Bearer ${userToken}`,
      },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new DeepSeekWebError(
      `Could not reach chat.deepseek.com: ${error?.message || String(error)}`,
      { status: 502, type: "upstream_error", code: "upstream_unreachable" },
    );
  }

  if (!response.ok) {
    /**
     * The 401 here is a *user* token rather than an access token, and a token
     * from another account or a signed-out session looks exactly like a dead
     * one, so this says so.
     */
    if (response.status === 401 || response.status === 403) {
      throw new DeepSeekWebError(
        "DeepSeek rejected that userToken. Sign in to chat.deepseek.com again and export a fresh one — a token from another account or a signed-out session looks exactly like this.",
        { status: 401, type: "authentication_error", code: `HTTP_${response.status}` },
      );
    }
    throw deepSeekRefusal(response.status, "exchanging the userToken for an access token");
  }

  const biz = unwrapDeepSeekBizData(await response.json().catch(() => null), "sign-in");
  const token = biz.token;
  if (typeof token !== "string" || !token) {
    throw new DeepSeekWebError("DeepSeek accepted the request but returned no access token.", {
      status: 401,
      type: "authentication_error",
      code: "no_access_token",
    });
  }
  return token;
}

/** The model ids chat.deepseek.com serves, read from the registry entry. */
export function deepSeekModelIds() {
  return (deepseekWebEntry.models || []).map((model) => model.id);
}

/**
 * Asks DeepSeek whether the pasted token means anything. Stores nothing.
 *
 * One round trip, no proof of work: `users/current` is the cheapest thing
 * DeepSeek answers, and the answer is the provider's own — "this token is
 * good" or "this token is not" — rather than a guess.
 */
export async function checkWebSession(credential) {
  let userToken;
  try {
    userToken = parseDeepSeekUserToken(credential);
  } catch (error) {
    const message = error?.message || "That is not a userToken.";
    return { ok: false, detail: message, error: message, models: [] };
  }

  try {
    await fetchDeepSeekAccessToken(userToken);
  } catch (error) {
    const message = error?.message || "DeepSeek did not accept that userToken.";
    return { ok: false, detail: message, error: message, models: [] };
  }

  return {
    ok: true,
    detail: "DeepSeek accepted the userToken.",
    models: deepSeekModelIds(),
  };
}

/**
 * Normalizes the paste into the credential to store.
 *
 * Verified **before** the save, so a refused token never becomes a connection
 * that reads as connected and answers nothing. The stored value is the bare
 * token, never the localStorage wrapper, so nothing has to be unwrapped again
 * on every turn.
 */
export async function connectWebSession(credential) {
  let userToken;
  try {
    userToken = parseDeepSeekUserToken(credential);
  } catch (error) {
    const message = error?.message || "That is not a userToken.";
    return { ok: false, error: message, detail: message };
  }

  try {
    await fetchDeepSeekAccessToken(userToken);
  } catch (error) {
    const message = error?.message || "DeepSeek did not accept that userToken.";
    return { ok: false, error: message, detail: message };
  }

  return {
    ok: true,
    credential: userToken,
    models: deepSeekModelIds(),
    name: "DeepSeek Web",
  };
}
