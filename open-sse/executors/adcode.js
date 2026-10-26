// ADCode "Included AI" (tagflow) executor — the ADCode desktop client's
// OpenAI-compatible relay (verified live 2026-10):
//
//   - Token minting comes from the desktop client's Firebase identity store
//     (see config/adcode.js): pasted key → env → refresh-token exchange.
//     chatCore skips its 401 refresh path for noAuth executors, so a
//     desktop-minted 401 is retried once here with a re-mint.
//   - The relay speaks native OpenAI chat/completions: standard SSE and
//     native tool_calls — no tool bridge needed (unlike zcode).
//   - Upstream limit codes (daily-limit / rate-limit / upstream-rate-limit,
//     error.limit session|weekly|daily) are coerced to 429/402 so account
//     rotation and backoff see the right status.

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  ADCODE_CHAT_URL,
  ADCODE_CONFIG_URL,
  ADCODE_USAGE_URL,
  clearAdcodeTokenCache,
  resolveAdcodeToken,
} from "../config/adcode.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Upstream limit taxonomy from the desktop client's own recovery logic:
// error.limit (or the code itself) naming a quota bucket → 429 when a bucket
// reset is imminent, 402 when the account's allowance is spent.
const LIMIT_RECOVERY = {
  "rate-limit": 429,
  "daily-limit": 429,
  "upstream-rate-limit": 429,
};
const LIMIT_BUCKETS = ["session", "weekly", "daily"];

function classifyAdcodeError(status, bodyText) {
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { /* keep raw */ }
  const code = parsed?.code || parsed?.error?.code;
  const limit = typeof parsed?.error?.limit === "string" ? parsed.error.limit : null;
  const message = parsed?.error?.message || parsed?.message || bodyText || `HTTP ${status}`;

  if (code && LIMIT_RECOVERY[code] && status < 400) {
    // A quota/rate condition can ride on any status — coerce to its 4xx form.
    return { status: LIMIT_RECOVERY[code], message: `${message}${limit ? ` (${limit} limit)` : ""}` };
  }
  if (code === "credits-exhausted" || (limit && LIMIT_BUCKETS.includes(limit) && status < 400)) {
    return { status: 402, message: `${message} (${limit || "credits"} pool spent)` };
  }
  return { status, message: String(message).slice(0, 300) };
}

export class AdcodeExecutor extends BaseExecutor {
  constructor() {
    super("adcode", PROVIDERS.adcode);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const request = { ...body };
    if (!request.model) request.model = model;

    const dispatch = async (token) => {
      const headers = this.buildHeadersFor(token, stream, credentials);
      return proxyAwareFetch(ADCODE_CHAT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal,
      }, proxyOptions);
    };

    let auth;
    try {
      auth = await resolveAdcodeToken(credentials, { signal, proxyOptions });
    } catch (error) {
      log?.error?.("ADCODE", `Credential error: ${error.message}`);
      const failure = new Error(`ADCode auth failed: ${error.message}`);
      failure.status = 401;
      throw failure;
    }

    log?.debug?.("ADCODE", `→ ${ADCODE_CHAT_URL} | model=${request.model} stream=${!!stream} auth=${auth.source}`);
    let response = await dispatch(auth.token);

    // chatCore skips token refresh for noAuth providers, so re-mint here:
    // the desktop store's refresh token may have been rotated or expired.
    if ((response.status === 401 || response.status === 403) && auth.source === "desktop") {
      clearAdcodeTokenCache();
      try {
        auth = await resolveAdcodeToken(credentials, { signal, proxyOptions });
        response = await dispatch(auth.token);
      } catch (error) {
        log?.warn?.("ADCODE", `Token re-mint after ${response.status} failed: ${error.message}`);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      log?.error?.("ADCODE", `Response ${response.status}: ${text.slice(0, 300)}`);
      const classified = classifyAdcodeError(response.status, text);
      const error = new Error(`ADCode API error ${classified.status}: ${classified.message}`);
      error.status = classified.status;
      throw error;
    }

    return { response, url: ADCODE_CHAT_URL, headers: {}, transformedBody: request };
  }

  buildHeadersFor(token, stream, credentials = null) {
    // Same client surface the desktop app sends (verified against its source):
    // the relay's persona/platform headers pin this to the "chat" lane, which
    // carries the account's Included-AI credit pools.
    const platform = process.env.ADCODE_PLATFORM?.trim() || process.platform;
    const headers = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${token}`,
      "x-adcode-ai-source": "chat",
      "x-adcode-ai-persona": "coding-assistant",
      "x-adcode-platform": platform,
    };
    // The connection key may carry headers the user opted into (rare, but the
    // default executor's header merge supports it for other providers).
    if (credentials?.providerSpecificData?.headers && typeof credentials.providerSpecificData.headers === "object") {
      Object.assign(headers, credentials.providerSpecificData.headers);
    }
    return headers;
  }

  buildUrl() {
    return ADCODE_CHAT_URL;
  }

  buildHeaders(credentials, stream) {
    return this.buildHeadersFor("public", stream, credentials);
  }

  parseError(response, bodyText) {
    const classified = classifyAdcodeError(response.status, bodyText);
    return { status: classified.status, message: classified.message };
  }
}

// Public live catalogue (no auth) — used by the dashboard models fetcher and
// the validate route. Returns the config payload ({ models: [...] }, ...).
export async function fetchAdcodeConfig({ signal, proxyOptions } = {}) {
  const response = await proxyAwareFetch(ADCODE_CONFIG_URL, {
    headers: { Accept: "application/json" },
    signal,
  }, proxyOptions);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(`ADCode config fetch failed: HTTP ${response.status}`);
  }
  return body;
}

// Read-only usage probe — Bearer id_token via the same resolver (a pasted
// key also works, so the dashboard can validate a saved connection).
export async function fetchAdcodeUsage(credentials, { signal, proxyOptions } = {}) {
  const auth = await resolveAdcodeToken(credentials, { signal, proxyOptions });
  const response = await proxyAwareFetch(ADCODE_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
    signal,
  }, proxyOptions);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || `HTTP ${response.status}`;
    const error = new Error(`ADCode usage check failed: ${String(detail).slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// Internal helpers exported for tests.
export { classifyAdcodeError, ADCODE_CHAT_URL, ADCODE_USAGE_URL };

export default AdcodeExecutor;
