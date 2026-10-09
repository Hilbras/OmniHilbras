import type { ModelPricing } from './types.js';

/**
 * Price normalisation.
 *
 * Providers quote in incompatible units, and a dashboard that has to know which provider
 * a model came from to render its price is a dashboard that renders the wrong number the
 * first time a new provider is added. Everything is converted to **per 1M tokens** at the
 * edge instead, and the two quoting styles are kept distinct rather than guessed at,
 * because a per-token `2.5` and a per-1M `2.5` mean very different things.
 */

/** Multiplier between a per-token price and a per-1M-token price. */
export const tokensPerMillion = 1_000_000;

/** A finite, non-negative price. Anything else is treated as unquoted. */
function price(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // `Number('')` is 0, so an empty or blank quote would otherwise read as free — the one
  // mistake a price filter cannot be allowed to make.
  if (!trimmed) return undefined;
  // Providers write zero as "0", "0.0" and "0.000", and never mean anything else by it.
  if (/^(?:0+(?:\.0*)?|\.0+)$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * A per-token quote, as OpenRouter publishes: `"0.0000025"` means $2.50 per 1M.
 *
 * Rejects anything implausible rather than rendering a nonsense figure: a per-token price
 * above the price of gold per token is a provider bug, not a price.
 */
export function perTokenPrice(value: unknown): number | undefined {
  const parsed = price(value);
  if (parsed === undefined) return undefined;
  const perMillion = parsed * tokensPerMillion;
  if (perMillion > 1_000_000) return undefined;
  return roundPrice(perMillion);
}

/** A per-1M quote, as OpenCode Zen publishes: `2.5` means 2.5 per 1M. */
export function perMillionPrice(value: unknown): number | undefined {
  const parsed = price(value);
  if (parsed === undefined) return undefined;
  if (parsed > 1_000_000) return undefined;
  return roundPrice(parsed);
}

/**
 * Keeps a price readable without lying about precision. Sub-cent differences are noise
 * on a filter and a tooltip, and four decimals is finer than any of these figures.
 */
function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Drops absent entries so an unquoted model does not report a price of zero. */
export function compactPricing(pricing: ModelPricing): ModelPricing | undefined {
  const entries = Object.entries(pricing).filter(([, value]) => value !== undefined) as Array<[keyof ModelPricing, number]>;
  return entries.length > 0 ? (Object.fromEntries(entries) as ModelPricing) : undefined;
}

/**
 * Modalities, normalised to lowercase. A provider that says nothing yields `undefined`
 * rather than an empty list, because "text only" and "not stated" are different facts and
 * a vision filter must not treat the second as the first.
 */
export function normalizeModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().toLowerCase();
    // A modality nobody can filter on is not worth carrying.
    if (normalized && normalized.length <= 32) seen.add(normalized);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/** A context window, when the provider states a plausible one. */
export function normalizeContextWindow(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  // Above ten million tokens is not a context window, it is a typo.
  return value <= 10_000_000 ? value : undefined;
}
