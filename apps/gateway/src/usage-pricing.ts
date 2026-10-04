import type { ModelPricing } from '@hilbras/omnihilbras';
import { tokensPerMillion } from '@hilbras/omnihilbras';

/**
 * What a set of records cost, computed from prices the providers actually quoted.
 *
 * ## The rule this file exists to enforce
 *
 * **A cost is only ever shown for a model whose provider quoted a price.** No defaults, no averages, no
 * "roughly" figures. `pricing.ts` already normalises every quote to per-1M tokens precisely so that a
 * dashboard never has to know which provider a model came from; this is the other half — turning those
 * numbers plus recorded tokens into a figure that can be put on a page.
 *
 * The alternative, and the reason this is written the way it is: fall back to a default price for a model
 * with no quote. That produces a number on every row, every row looks equally trustworthy, and the ones
 * that are invented are indistinguishable from the ones that are real. A page that says "cost unknown for
 * 6 of your 9 models" is useful; a page that says "$4.21" when three of those figures came from a constant
 * is not.
 *
 * ## Why cost is computed at read time, not stored
 *
 * Prices change — a provider cuts a price, or a connection is re-scanned and a new quote arrives. A stored
 * cost is a historical fact about a *quote*, and the page would keep showing it after the quote was wrong.
 * Tokens are stored; the multiplication happens when asked. That also means this file touches no storage and
 * is pure, which is why it can be tested without a gateway.
 */

/** One priced result, or the honest absence of one. */
export type PricedUsage = {
  /** USD, summed across every record that could be priced. */
  costUsd: number;
  /** How many records contributed. Records with no price are **not** counted here. */
  pricedRequests: number;
  /**
   * How many records were skipped for want of a price. **Non-zero is a normal state, not a bug** — most
   * connections to an API-key provider carry no price at all, because the provider does not publish one.
   */
  unpricedRequests: number;
  /** True when nothing could be priced, so `costUsd: 0` means "unknown", not "free". */
  unpricedEntirely: boolean;
};

/** Tokens and a price, which is all the arithmetic needs. */
export type PriceableUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Cache reads and writes bill at their own rates and are reported separately by some providers. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  pricing?: ModelPricing;
};

/** Fractional cents are noise on a page; six decimals is finer than any published price. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * What one request cost, or `undefined` when it cannot be priced.
 *
 * Undefined rather than 0 for a missing price, because a zero-cost request (a genuinely free tier) and an
 * unpriceable one (no quote at all) are different facts and a total that adds them together lies.
 *
 * Half-priced is not invented: a price with an output rate but no input rate cannot be halved without
 * assuming, so a partial quote prices only the half it actually covers.
 */
export function requestCostUsd(usage: PriceableUsage): number | undefined {
  const { pricing } = usage;
  if (!pricing) return undefined;

  const parts: number[] = [];
  const add = (tokens: number | undefined, ratePer1M: number | undefined) => {
    if (tokens === undefined || ratePer1M === undefined) return;
    if (!Number.isFinite(tokens) || tokens < 0) return;
    parts.push((tokens / tokensPerMillion) * ratePer1M);
  };

  add(usage.inputTokens, pricing.inputPer1M);
  add(usage.outputTokens, pricing.outputPer1M);
  add(usage.cacheReadTokens, pricing.cacheReadPer1M);
  add(usage.cacheWriteTokens, pricing.cacheWritePer1M);

  // A quote with rates but no matching tokens is not zero cost — it is a request we could not measure.
  return parts.length > 0 ? roundUsd(parts.reduce((total, part) => total + part, 0)) : undefined;
}

/**
 * Totals across many records.
 *
 * `records` are anything with the priceable fields, so a `UsageRecord` plus a price lookup is enough and the
 * store's own type does not have to change.
 */
export function priceUsage<T extends PriceableUsage>(records: readonly T[]): PricedUsage {
  let costUsd = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;

  for (const record of records) {
    const cost = requestCostUsd(record);
    if (cost === undefined) unpricedRequests += 1;
    else {
      costUsd += cost;
      pricedRequests += 1;
    }
  }

  return {
    costUsd: roundUsd(costUsd),
    pricedRequests,
    unpricedRequests,
    // `records.length === 0` is not "nothing was priced" in the sense that matters: an empty page should say
    // so rather than implying a figure. Distinguishing it keeps a caller from rendering "$0.00" on day one.
    unpricedEntirely: records.length === 0 || pricedRequests === 0,
  };
}

/**
 * What a page must say alongside a total.
 *
 * A single string, because the failure this prevents is a page showing "$4.21" with no indication that four
 * requests were priced from nothing. `null` when everything was priced, because a caveat that is always
 * shown is a caveat nobody reads.
 */
export function pricingCaveat(priced: PricedUsage): string | null {
  if (priced.unpricedRequests === 0) return null;
  if (priced.pricedRequests === 0) {
    const requests = `${priced.unpricedRequests} recorded request${priced.unpricedRequests === 1 ? '' : 's'}`;
    return `No cost shown: none of the ${requests} had a price from its provider.`;
  }
  return `Cost covers ${priced.pricedRequests} of ${priced.pricedRequests + priced.unpricedRequests} requests; the rest had no published price.`;
}
