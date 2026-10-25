/**
 * ZCode usage — GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
 * Auth: local ZCode desktop credential store (or a pasted Start Plan JWT as
 * the connection key) — resolved inside fetchZcodeBalance.
 *
 * Balance rows are per model × entitlement bucket (daily Start Plan pools plus
 * one-time promotional grants), each with its own total/remaining/period.
 */

import { fetchZcodeBalance } from "../../executors/zcode.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";

/**
 * Map the balance payload → { plan, quotas, message } for the dashboard.
 * One quota row per balance bucket, labeled "MODEL · plan" so multiple
 * buckets for the same model stay distinguishable.
 */
export function parseZcodeBalanceUsage(body) {
  const data = body?.data || {};
  const planNames = new Map();
  for (const plan of data.plans || []) {
    if (plan?.plan_id) planNames.set(String(plan.plan_id), plan.name || plan.plan_id);
  }

  const quotas = {};
  for (const row of data.balances || []) {
    if (!row || typeof row !== "object") continue;
    const total = Math.max(0, toFiniteNumber(row.total_units, 0));
    const remaining = Math.max(0, toFiniteNumber(row.remaining_units, 0));
    if (total <= 0) continue;
    const used = Math.min(total, toFiniteNumber(row.used_units, total - remaining));
    const planId = String(row.plan_id || "");
    const planLabel = /trust/i.test(planId)
      ? "Trust Build Promo"
      : planNames.get(planId) || "Start Plan";
    const modelLabel = String(row.show_name || "Model");
    quotas[`${modelLabel} · ${planLabel}`] = {
      used,
      total,
      remainingPercentage: (Math.max(0, total - used) / total) * 100,
      resetAt: parseResetTime(row.period_end ?? row.expires_at ?? null),
      unlimited: false,
    };
  }

  return {
    plan: "ZCode Start Plan",
    quotas,
    message: Object.keys(quotas).length
      ? null
      : "No active ZCode quota buckets on this account.",
  };
}

/**
 * @param {object} connection ctx from USAGE_HANDLERS: { apiKey, accessToken, providerSpecificData, proxyOptions }
 */
export async function getZcodeUsage(c = {}) {
  const credentials = { apiKey: c.apiKey || c.accessToken, providerSpecificData: c.providerSpecificData };
  try {
    const body = await fetchZcodeBalance(credentials, { proxyOptions: c.proxyOptions });
    return parseZcodeBalanceUsage(body);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("credentials not found")) {
      return { message: "ZCode desktop client is not signed in on this machine. Install ZCode and sign in once." };
    }
    return { message: `ZCode error: ${message}` };
  }
}
