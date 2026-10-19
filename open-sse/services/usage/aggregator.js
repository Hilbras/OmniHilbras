/**
 * Aggregator usage — one-api/new-api style hosts (freeTier group: tokenharbor,
 * nara-router, apmix, apinex, tiarina, xkiro). Endpoints/config come from each
 * provider's registry (transport.usage.apiBase + optional flavor pin), not from
 * this file.
 *
 * Candidate flavors, tried in AGGREGATOR_USAGE_CONFIG order unless the registry
 * pins one (usage.flavor):
 *   openai-billing — GET {apiBase}/dashboard/billing/subscription
 *                      { system_hard_limit_usd | hard_limit_usd }
 *                    + GET {apiBase}/dashboard/billing/usage?start_date&end_date
 *                      { total_usage } — USD cents
 *   new-api        — GET {origin}/api/user/self — quota in new-api quota units
 *                    (AGGREGATOR_USAGE_CONFIG.newApiQuotaPerUnit per USD)
 *   headers        — x-ratelimit-* scan on the zero-cost /models call
 *                    (same trick usage/groq.js uses)
 *   local (fallback, never pinned away by a remote miss) — our own
 *                    usageHistory for this connection over the last
 *                    usageWindowDays: tokens + requests as "unlimited" rows.
 *                    Redundant with upstream flavors, so it only runs when
 *                    none of them worked (or the unsupported cooldown is up)
 *
 * Fail-open like every other usage adapter: results are {plan, quotas} or
 * {plan, message}; this module never throws.
 */

import REGISTRY from "../../providers/registry/index.js";
import { PROVIDERS } from "../../providers/index.js";
import { AGGREGATOR_USAGE_CONFIG } from "../../config/runtimeConfig.js";
import { fetchWithTimeout, resetAtFromDuration, toFiniteNumber } from "./shared.js";

// providerId → epoch ms; hits suppress re-probing for unsupportedTtlMs so each
// 60s dashboard poll doesn't hammer a host that simply has no billing API.
const unsupportedUntil = new Map();

const DISPLAY_NAMES = new Map(REGISTRY.map((e) => [e.id, e.display?.name || e.id]));

function planName(provider) {
  return DISPLAY_NAMES.get(provider) || provider;
}

function resolveTargets(provider) {
  const cfg = PROVIDERS[provider] || {};
  const validateUrl = typeof cfg.validateUrl === "string" ? cfg.validateUrl : null;
  const apiBase = (cfg.usage && cfg.usage.apiBase)
    ? cfg.usage.apiBase.replace(/\/$/, "")
    : (validateUrl ? validateUrl.replace(/\/models\/?$/, "").replace(/\/$/, "") : null);
  if (!apiBase) return null;
  return {
    apiBase,
    validateUrl,
    pinned: (cfg.usage && cfg.usage.flavor) || null,
  };
}

async function tryGetJson(url, apiKey, proxyOptions) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: "application/json",
      },
    },
    AGGREGATOR_USAGE_CONFIG.fetchTimeoutMs,
    proxyOptions,
  );
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function remainingPercentage(remaining, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = Math.round((remaining / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

// openai-billing: subscription ceiling + usage-so-far window (cents → USD).
async function tryOpenAIBilling(targets, apiKey, proxyOptions, sawAuthError) {
  const sub = await tryGetJson(`${targets.apiBase}/dashboard/billing/subscription`, apiKey, proxyOptions);
  if (sub.status === 401 || sub.status === 403) {
    sawAuthError.value = true;
    return null;
  }
  if (sub.status !== 200 || !sub.data || typeof sub.data !== "object") return null;

  const total = toFiniteNumber(
    sub.data.system_hard_limit_usd ?? sub.data.hard_limit_usd,
    NaN,
  );
  if (!Number.isFinite(total)) return null;

  const days = AGGREGATOR_USAGE_CONFIG.usageWindowDays;
  const start = isoDate(Date.now() - days * 86400000);
  const end = isoDate(Date.now());
  const usage = await tryGetJson(
    `${targets.apiBase}/dashboard/billing/usage?start_date=${start}&end_date=${end}`,
    apiKey,
    proxyOptions,
  );
  if (usage.status === 401 || usage.status === 403) {
    sawAuthError.value = true;
    return null;
  }
  // Missing usage route on the same key is fine: treat spend as 0.
  const used = Number.isFinite(usage.status) && usage.status === 200
    ? toFiniteNumber(usage.data?.total_usage, 0) / 100
    : 0;

  const remaining = Math.max(0, total - used);
  return {
    flavor: "openai-billing",
    plan: "openai-billing",
    quotas: {
      "Wallet (USD)": {
        used: Math.round(used * 100) / 100,
        total,
        remainingPercentage: remainingPercentage(remaining, total),
        resetAt: null,
        unlimited: false,
        isCreditBalance: true,
        currency: "USD",
      },
    },
  };
}

// new-api: /api/user/self carries the wallet state in quota units.
async function tryNewApi(targets, apiKey, proxyOptions, sawAuthError) {
  let origin;
  try {
    origin = new URL(targets.apiBase).origin;
  } catch {
    return null;
  }
  const self = await tryGetJson(`${origin}/api/user/self`, apiKey, proxyOptions);
  if (self.status === 401 || self.status === 403) {
    sawAuthError.value = true;
    return null;
  }
  if (self.status !== 200 || !self.data || typeof self.data !== "object") return null;

  const selfData = self.data.data && typeof self.data.data === "object" ? self.data.data : self.data;
  const perUnit = AGGREGATOR_USAGE_CONFIG.newApiQuotaPerUnit;
  const remaining = toFiniteNumber(selfData.quota ?? selfData.remaining_quota, NaN);
  const used = toFiniteNumber(selfData.used_quota ?? selfData.usedQuota, NaN);
  if (!Number.isFinite(remaining) && !Number.isFinite(used)) return null;

  const usedUsd = Number.isFinite(used) ? used / perUnit : 0;
  const totalUsd = Number.isFinite(remaining)
    ? usedUsd + remaining / perUnit
    : usedUsd;

  return {
    flavor: "new-api",
    plan: "new-api",
    quotas: {
      "Wallet (USD)": {
        used: Math.round(usedUsd * 100) / 100,
        total: Math.round(totalUsd * 100) / 100,
        remainingPercentage: remainingPercentage(totalUsd - usedUsd, totalUsd),
        resetAt: null,
        unlimited: false,
        isCreditBalance: true,
        currency: "USD",
      },
    },
  };
}

// headers: rate-limit info rides on every response (groq pattern).
async function tryRateLimitHeaders(targets, apiKey, proxyOptions) {
  const checkUrl = targets.validateUrl || `${targets.apiBase}/models`;
  const response = await fetchWithTimeout(
    checkUrl,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: "application/json",
      },
    },
    AGGREGATOR_USAGE_CONFIG.fetchTimeoutMs,
    proxyOptions,
  );
  if (response.status === 401 || response.status === 403) return { auth: true };
  if (response.status !== 200) return null;

  const build = (limitKey, remainingKey, resetKey) => {
    const limitRaw = response.headers.get(limitKey);
    const remainingRaw = response.headers.get(remainingKey);
    if (limitRaw === null || remainingRaw === null) return null;
    const limit = Number(limitRaw);
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;
    return {
      used: Math.max(0, limit - remaining),
      total: limit,
      resetAt: resetAtFromDuration(response.headers.get(resetKey)),
      unlimited: false,
    };
  };

  const requests = build("x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests");
  const tokens = build("x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens");
  if (!requests && !tokens) return null;

  const quotas = {};
  if (requests) quotas["Requests (rate limit)"] = { ...requests, isCreditBalance: false };
  if (tokens) quotas["Tokens (rate limit)"] = { ...tokens, isCreditBalance: false };
  return { flavor: "headers", plan: "headers", quotas, auth: false };
}

// local: fall back to this router's own usage history for the connection.
// QuotaTable renders `unlimited` rows as "N used · Unlimited" (green, no bar),
// which is exactly right — locally observed usage has no limit to compare to.
async function tryLocalHistory({ connectionId, windowDays }) {
  if (!connectionId) return null;
  try {
    const { getUsageTotalsForConnection } = await import("@/lib/db/repos/usageRepo.js");
    const totals = await getUsageTotalsForConnection(connectionId, windowDays * 86400000);
    if (!totals) return null;
    const base = { total: null, resetAt: null, isCreditBalance: false, unlimited: true };
    return {
      flavor: "local",
      plan: "local",
      quotas: {
        [`Tokens · local history (${windowDays}d)`]: { ...base, used: totals.tokens },
        [`Requests · local history (${windowDays}d)`]: { ...base, used: totals.requests },
      },
    };
  } catch {
    return null;
  }
}

/**
 * @param {Object} ctx - connection fields from getUsageForProvider
 * @param {string} ctx.provider - provider id (registry key)
 * @param {string|null} ctx.connectionId - local connection id (for the local-history fallback)
 * @param {string|null} ctx.apiKey
 * @param {Object|null} ctx.proxyOptions
 */
export async function getAggregatorUsage({ provider, connectionId = null, apiKey, proxyOptions = null } = {}) {
  const name = planName(provider);
  try {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return { plan: name, message: `${name} API key not available. Add a key to view usage.` };
    }

    const targets = resolveTargets(provider);
    if (!targets) {
      return { plan: name, message: `${name} usage endpoints are not configured.` };
    }

    const sawAuthError = { value: false };
    let result = null;
    // Local history is our own data: it survives (and feeds through) the
    // unsupported-probe cooldown instead of repeating the stale message.
    const probingSuppressed =
      targets.pinned !== "local"
      && (() => { const until = unsupportedUntil.get(provider); return !!(until && Date.now() < until); })();

    if (!probingSuppressed && targets.pinned !== "local") {
      const runners = [
        ["openai-billing", () => tryOpenAIBilling(targets, apiKey, proxyOptions, sawAuthError)],
        ["new-api", () => tryNewApi(targets, apiKey, proxyOptions, sawAuthError)],
        ["headers", () => tryRateLimitHeaders(targets, apiKey, proxyOptions)],
      ];

      for (const [flavor, run] of runners) {
        if (targets.pinned && targets.pinned !== flavor) continue;
        result = await run();
        if (result?.auth) { sawAuthError.value = true; result = null; continue; }
        if (result) break;
      }
    }

    // No remote flavor answered — show locally observed usage if we have any.
    if (!result && !sawAuthError.value) {
      result = await tryLocalHistory({
        connectionId,
        windowDays: AGGREGATOR_USAGE_CONFIG.usageWindowDays,
      });
    }

    if (result) {
      if (result.flavor !== "local") unsupportedUntil.delete(provider);
      return {
        plan: result.plan === "headers" ? `${name} (rate limit)` : name,
        quotas: result.quotas,
      };
    }

    if (sawAuthError.value) {
      return { plan: name, message: `${name} authentication failed. Check the API key.` };
    }

    unsupportedUntil.set(provider, Date.now() + AGGREGATOR_USAGE_CONFIG.unsupportedTtlMs);
    return {
      plan: name,
      message: `${name} doesn't expose a usage API yet — quota appears once they add billing endpoints.`,
    };
  } catch (error) {
    return { plan: name, message: `${name} usage error: ${error.message}` };
  }
}