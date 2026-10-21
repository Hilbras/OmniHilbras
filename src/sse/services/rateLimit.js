// Client-facing request bounds for the /v1 inference API.
//
// The gateway has a thorough UPSTREAM quota engine (per-model locks, backoff,
// retry-after), but nothing bounded what a CLIENT could ask for: one leaked
// key could drive unlimited spend on the operator's real provider accounts,
// N concurrent client requests opened N upstream sockets and buffered N bodies
// (up to 128 MB each), and one request could fan out into an unbounded number
// of upstream calls (accounts x combo models x fusion panels).
//
// Three independent bounds, all configured from the dashboard settings
// (src/lib/db/repos/settingsRepo.js → DEFAULT_SETTINGS.rateLimit):
//
//   1. a token bucket per identity — the presented API key, else the peer IP —
//      with a requests-per-minute and a tokens-per-minute ceiling;
//   2. a concurrency cap (global + per key) on in-flight client requests;
//   3. a per-request budget on upstream calls (open-sse/services/fanOut.js).
//
// EVERYTHING HERE FAILS OPEN. The limiter is a guard rail, not a dependency:
// if any part of it throws, the request is let through. A broken limiter must
// never take the gateway down — that is the same rule the optional savers on
// the request path follow (they return null on error).
//
// Local CLI traffic is exempt: the operator's own tooling on the box must
// never be throttled by the client limiter, and the CLI is the one caller
// that legitimately drives the gateway hardest.
import { getSettings } from "@/lib/localDb";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { DEFAULT_SETTINGS } from "@/lib/db/repos/settingsRepo.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { isLocalRequest } from "@/dashboardGuard.js";
import { trackClientRequest, getClientRequestCounts } from "@/lib/usageDb.js";
import { keyIdentity, ipIdentity, spendRequests, spendTokens } from "@/shared/utils/rateLimitBucket.js";
import { recordSpend, recordRejection, getCounterList } from "@/shared/utils/rateLimitCounters.js";
import { createFanOutBudget } from "open-sse/services/fanOut.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { extractClientApiKey } from "./keyAccess.js";
import * as log from "../utils/logger.js";

const DEFAULTS = DEFAULT_SETTINGS.rateLimit;

// ~4 characters per token is the usual approximation for JSON/text payloads.
const CHARS_PER_TOKEN = 4;

// How long a rejected client is told to wait before retrying.
const CONCURRENCY_RETRY_AFTER_SEC = 5;

/**
 * A numeric limit. 0 is a valid value and means "no limit" for this dimension;
 * anything unparseable falls back to the default.
 */
function limitNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Estimate the input tokens of a request from its body size.
 *
 * The body itself is not read here: the handler owns `request.json()` and the
 * body can be 128 MB, so the estimate uses the Content-Length header.
 * Only JSON payloads are billed as tokens — an audio upload for STT or an
 * image upload is bounded by the request-rate and concurrency caps instead,
 * because charging their bytes as tokens would let one upload drain a whole
 * minute's budget.
 */
function estimateInputTokens(request, rl) {
  const contentType = request?.headers?.get?.("content-type") || "";
  if (!/json/i.test(contentType)) return 0;
  const bytes = Number.parseInt(request?.headers?.get?.("content-length") || "", 10);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const cap = limitNumber(rl.maxInputTokensPerRequest, DEFAULTS.maxInputTokensPerRequest);
  return Math.min(cap, Math.ceil(bytes / CHARS_PER_TOKEN));
}

/**
 * Who is making this request.
 *
 * A presented key identifies the caller by the key row it resolves to (so the
 * dashboard can raise the ceiling for exactly one key). An unknown or
 * unreadable key still gets its own bucket, keyed by a hash of the presented
 * secret, so rotating an invalid key does not buy a fresh budget.
 *
 * Without a key the caller is bucketed by peer IP. The IP is derived the same
 * way the login lockout derives it (src/lib/auth/loginLimiter.js): the
 * x-9r-real-ip header is only trusted when custom-server.js proved it stamped
 * it, XFF only behind TRUST_PROXY, and everything else shares one "unknown"
 * bucket — a client must not be able to rotate a header to escape its own
 * limit.
 */
export async function resolveClientIdentity(request) {
  const apiKey = extractClientApiKey(request);
  if (apiKey) {
    const bucket = keyIdentity(apiKey);
    let keyId = null;
    let keyName = null;
    try {
      const record = await getApiKeyByKey(apiKey);
      if (record?.id) {
        keyId = record.id;
        keyName = record.name || record.id;
      }
    } catch {
      // An unreadable key row must not block the request: fall back to the
      // hashed bucket below.
    }
    return { bucket, scope: keyId ? `key:${keyId}` : bucket, keyId, keyName, byKey: true };
  }
  const ip = getClientIp(request);
  const bucket = ipIdentity(ip);
  return { bucket, scope: bucket, keyId: null, keyName: null, byKey: false, ip };
}

/**
 * The limits that apply to one identity: the global defaults, raised (or
 * lowered) by that key's override when it has one. An override applies to that
 * one key only — every other key keeps the global ceiling.
 */
export function resolveLimits(rl, identity) {
  const base = {
    requestsPerMinute: limitNumber(rl?.requestsPerMinute, DEFAULTS.requestsPerMinute),
    tokensPerMinute: limitNumber(rl?.tokensPerMinute, DEFAULTS.tokensPerMinute),
    concurrencyGlobal: limitNumber(rl?.concurrency?.global, DEFAULTS.concurrency.global),
    concurrencyPerKey: limitNumber(rl?.concurrency?.perKey, DEFAULTS.concurrency.perKey),
  };
  const override = identity?.keyId ? rl?.keyOverrides?.[identity.keyId] : null;
  if (!override || typeof override !== "object") return base;
  return {
    requestsPerMinute: limitNumber(override.requestsPerMinute, base.requestsPerMinute),
    tokensPerMinute: limitNumber(override.tokensPerMinute, base.tokensPerMinute),
    concurrencyGlobal: base.concurrencyGlobal,
    concurrencyPerKey: limitNumber(override.concurrency, base.concurrencyPerKey),
  };
}

/**
 * Take a slot from the in-flight counters.
 * Reuses the pending-request counter (src/lib/db/repos/usageRepo.js) so the
 * gateway's concurrency cap and the dashboard's "active requests" view agree
 * on what is in flight.
 */
function acquireConcurrency(identity, limits) {
  const scope = identity.scope || "unknown";
  const counts = getClientRequestCounts();
  if (limits.concurrencyGlobal > 0 && counts.total >= limits.concurrencyGlobal) {
    return { acquired: false, reason: "global" };
  }
  if (limits.concurrencyPerKey > 0 && (counts.byScope?.[scope] || 0) >= limits.concurrencyPerKey) {
    return { acquired: false, reason: "key" };
  }
  trackClientRequest(scope, true);
  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      trackClientRequest(scope, false);
    },
  };
}

function rateLimitedResponse(dimension, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const message =
    dimension === "tokens"
      ? `Rate limit exceeded: too many tokens per minute for this key. Retry after ${seconds}s.`
      : `Rate limit exceeded: too many requests per minute for this key. Retry after ${seconds}s.`;
  return errorResponse(HTTP_STATUS.RATE_LIMITED, message, { "Retry-After": String(seconds) });
}

function concurrencyResponse(reason) {
  const message =
    reason === "global"
      ? `Gateway is at capacity: too many requests in flight. Retry after ${CONCURRENCY_RETRY_AFTER_SEC}s.`
      : `Too many concurrent requests for this key. Retry after ${CONCURRENCY_RETRY_AFTER_SEC}s.`;
  return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, message, {
    "Retry-After": String(CONCURRENCY_RETRY_AFTER_SEC),
  });
}

/**
 * Report what the limiter did.
 *
 * The counters must never affect the request: a broken counter must not turn
 * into a rejected request. The limiter fails open, and so does the reporting.
 */
function safeCount(fn) {
  try {
    fn();
  } catch {
    /* the limiter fails open — and so does the reporting */
  }
}

/**
 * The scope of a request whose identity could not be resolved (the limiter
 * threw before the key lookup finished): the hash of the presented key, or the
 * peer IP. Never the key itself.
 */
function fallbackScope(request) {
  try {
    const apiKey = extractClientApiKey(request);
    if (apiKey) return keyIdentity(apiKey);
    return ipIdentity(getClientIp(request));
  } catch {
    return "unknown";
  }
}

/**
 * Decide whether a request may proceed, and take the resources it needs.
 * @returns {{response?: Response, ctx?: object, release?: Function}}
 */
async function admit(request) {
  // Local CLI traffic: exempt from every bound.
  if (isLocalRequest(request)) return { ctx: {} };

  const settings = await getSettings();
  const rl = settings?.rateLimit;
  // The global kill-switch: no rate limit, no concurrency cap, no fan-out cap.
  if (!rl || rl.enabled === false) return { ctx: {} };

  const identity = await resolveClientIdentity(request);
  const limits = resolveLimits(rl, identity);
  // What the limiter does is recorded, so an operator can see it: a rejection
  // used to leave nothing but a console warning. The counters hold the scope
  // and the key's id — never the key.
  const counterMeta = { keyId: identity.keyId, keyName: identity.keyName };

  // The request bucket: one token per client request.
  const requestTokens = spendRequests(identity.bucket, limits.requestsPerMinute, 1);
  if (!requestTokens.allowed) {
    log.warn("RATELIMIT", `requests/min exceeded for ${identity.bucket}`);
    safeCount(() => recordRejection(identity.scope, "requests", counterMeta));
    return { response: rateLimitedResponse("requests", requestTokens.retryAfterMs) };
  }

  // The token bucket: the estimated prompt size of this request.
  const estimatedTokens = estimateInputTokens(request, rl);
  const tokenSpend = spendTokens(identity.bucket, limits.tokensPerMinute, estimatedTokens);
  if (!tokenSpend.allowed) {
    log.warn("RATELIMIT", `tokens/min exceeded for ${identity.bucket}`);
    safeCount(() => recordRejection(identity.scope, "tokens", counterMeta));
    return { response: rateLimitedResponse("tokens", tokenSpend.retryAfterMs) };
  }

  const slot = acquireConcurrency(identity, limits);
  if (!slot.acquired) {
    log.warn("RATELIMIT", `concurrency cap reached (${slot.reason}) for ${identity.bucket}`);
    safeCount(() => recordRejection(identity.scope, "concurrency", counterMeta));
    return { response: concurrencyResponse(slot.reason) };
  }

  safeCount(() => recordSpend(identity.scope, { requests: 1, tokens: estimatedTokens, ...counterMeta }));

  return {
    ctx: {
      identity,
      limits,
      // One budget per client request: every upstream call it triggers spends
      // from it, so accounts x combo models x fusion panels stay bounded.
      // The exhaustion is reported from here: the budget is spent in the
      // handlers, which the limiter never sees.
      fanOutBudget: createFanOutBudget(rl.maxUpstreamCallsPerRequest, () => {
        safeCount(() => recordRejection(identity.scope, "fanout", counterMeta));
      }),
    },
    release: slot.release,
  };
}

/**
 * What the limiter has been doing, as the dashboard shows it.
 *
 * The counters hold what each identity spent in the last minute and how often
 * it was turned away; the limits come from the settings and the per-key
 * override, so the card can show "used / ceiling".
 *
 * @returns {Promise<object>}
 */
export async function getRateLimitStatus() {
  const settings = await getSettings();
  const rl = settings?.rateLimit || DEFAULTS;
  const identities = getCounterList().map((counter) => {
    const limits = resolveLimits(rl, { keyId: counter.keyId });
    return {
      ...counter,
      limits: {
        requestsPerMinute: limits.requestsPerMinute,
        tokensPerMinute: limits.tokensPerMinute,
        concurrencyPerKey: limits.concurrencyPerKey,
      },
    };
  });

  return {
    enabled: rl.enabled !== false,
    defaults: {
      requestsPerMinute: limitNumber(rl?.requestsPerMinute, DEFAULTS.requestsPerMinute),
      tokensPerMinute: limitNumber(rl?.tokensPerMinute, DEFAULTS.tokensPerMinute),
      concurrency: {
        global: limitNumber(rl?.concurrency?.global, DEFAULTS.concurrency.global),
        perKey: limitNumber(rl?.concurrency?.perKey, DEFAULTS.concurrency.perKey),
      },
      maxUpstreamCallsPerRequest: limitNumber(
        rl?.maxUpstreamCallsPerRequest,
        DEFAULTS.maxUpstreamCallsPerRequest,
      ),
    },
    identities,
    inFlight: getClientRequestCounts(),
  };
}

/**
 * Release the concurrency slot when the response body is done.
 * The slot must be held for the whole stream: the upstream socket (and the
 * buffered request body) lives until the last byte, not until the headers.
 */
function releaseWhenBodyEnds(response, release) {
  if (!release) return response;
  try {
    const body = response?.body;
    if (!body || typeof body.getReader !== "function") {
      release();
      return response;
    }
    const reader = body.getReader();
    let released = false;
    const once = () => {
      if (released) return;
      released = true;
      release();
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            once();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          once();
          controller.error(error);
        }
      },
      cancel(reason) {
        once();
        reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // The wrapper must never break the response it wraps.
    release();
    return response;
  }
}

/**
 * Run a /v1 handler under the request bounds.
 *
 * @param {Request} request
 * @param {(ctx: {identity?: object, limits?: object, fanOutBudget?: object}) => Promise<Response>} handler
 * @returns {Promise<Response>}
 */
export async function enforceRequestLimits(request, handler) {
  let admission;
  try {
    admission = await admit(request);
  } catch (error) {
    // Fail open: a limiter that throws must not take the gateway down.
    log.warn("RATELIMIT", `limiter error — allowing request: ${error?.message || error}`);
    // The limiter itself failed, so the client was let through: that is worth
    // seeing too — it means the bounds were not applied to this request.
    safeCount(() => recordRejection(fallbackScope(request), "error", {}));
    admission = { ctx: {} };
  }

  if (admission.response) return admission.response;
  if (!admission.release) return await handler(admission.ctx || {});

  let response;
  try {
    response = await handler(admission.ctx || {});
  } catch (error) {
    admission.release();
    throw error;
  }
  return releaseWhenBodyEnds(response, admission.release);
}
