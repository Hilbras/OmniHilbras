/**
 * ADCode (tagflow) usage — GET {base}/usage on the account's id_token,
 * resolved from the desktop client's Firebase identity store (or a pasted
 * id_token as the connection key) — see config/adcode.js.
 *
 * The ADCode Included-AI allowance is credit-based. /usage reports the
 * account's live credit pools (session 5h + weekly, with per-pool resets)
 * plus the token/cost limits; the pools size the "included" quotas here.
 * Fail-open, like the other usage adapters: any error becomes a message,
 * never a thrown error.
 */

import { fetchAdcodeUsage } from "../../executors/adcode.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

/**
 * Map the /usage payload → { plan, quotas, message } for the dashboard.
 *
 * Real shape (verified live 2026-10):
 *   credits: { plan: { sessionCredits, weeklyCredits, sessionHours },
 *              session: { limit, used, remaining, resetsAt },
 *              weekly:  { limit, used, remaining, resetsAt },
 *              rates: { <model>: number } },
 *   limits: { dailyRequests, dailyTokens, dailyCostMicros, requestsPerMinute },
 *   today:  { inputTokens, outputTokens, … },
 *   unlimited: boolean
 */
export function parseAdcodeUsage(body) {
  const credits = body?.credits || {};
  const plan = credits.plan || {};
  const quotas = {};

  const pool = (label, source, fallbackLimit) => {
    if (!source) return; // no live pool → rely on the unlimited flag
    const limit = Math.max(0, toFiniteNumber(source.limit, toFiniteNumber(fallbackLimit, 0)));
    if (limit <= 0 && !body?.unlimited) return;
    const used = Math.min(limit, Math.max(0, toFiniteNumber(source.used, 0)));
    const remaining = Math.max(0, toFiniteNumber(source.remaining, limit - used));
    // An unlimited entitlement reports the pool size but never accumulates
    // "used" the way a metered plan does — keep the row informational.
    const metered = !body?.unlimited;
    quotas[label] = {
      used: metered ? used : 0,
      total: limit,
      remainingPercentage: limit > 0 ? ((metered ? remaining : limit) / limit) * 100 : 100,
      resetAt: parseResetTime(source.resetsAt ?? null),
      unlimited: !!body?.unlimited,
    };
  };

  pool(`Session credits (${toFiniteNumber(plan.sessionHours, 5)}h)`, credits.session, plan.sessionCredits);
  pool("Weekly credits", credits.weekly, plan.weeklyCredits);

  if (body?.unlimited && Object.keys(quotas).length === 0) {
    quotas["Included AI credits"] = { used: 0, total: 0, remainingPercentage: 100, resetAt: null, unlimited: true };
  }

  // Daily token consumption, if the endpoint reports it.
  const inTok = toFiniteNumber(body?.today?.inputTokens, 0);
  const outTok = toFiniteNumber(body?.today?.outputTokens, 0);
  if (inTok || outTok) {
    quotas["Tokens (today)"] = { used: inTok + outTok, total: 0, unlimited: true };
  }

  return {
    plan: "ADCode Included AI",
    quotas,
    message: Object.keys(quotas).length ? null : "Connected. No usage detail returned for this account yet.",
  };
}

/**
 * @param {object} connection ctx from USAGE_HANDLERS: { apiKey, accessToken, providerSpecificData, proxyOptions }
 */
export async function getAdcodeUsage(c = {}) {
  const credentials = {
    apiKey: c.apiKey || c.accessToken,
    accessToken: c.accessToken || c.apiKey,
    providerSpecificData: c.providerSpecificData,
  };
  try {
    const body = await fetchAdcodeUsage(credentials, { proxyOptions: c.proxyOptions });
    return parseAdcodeUsage(body);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("not signed in")) {
      return { message: "ADCode desktop client is not signed in on this machine. Install ADCode and sign in once, or paste an ADCode id_token as the key." };
    }
    return { message: `ADCode error: ${message}` };
  }
}
