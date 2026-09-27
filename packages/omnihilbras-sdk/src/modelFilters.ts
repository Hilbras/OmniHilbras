/**
 * Model filtering, derived from what a provider's catalog actually said.
 *
 * The rule throughout: **an absent field is not a zero.** A provider that publishes no
 * price has not said a model is free, and a provider that publishes no modalities has not
 * said a model is text-only. Filters therefore distinguish "stated" from "unstated", and
 * say so in the UI rather than quietly treating a missing value as a match.
 */

/**
 * The compact catalog metadata carried alongside a connection's model ids. Keys are short
 * because a full catalog runs to hundreds of entries per connection and this is written
 * into a metadata file with a hard size cap.
 */
export type ModelMeta = {
  /** Display name. */
  n?: string;
  /** Context window in tokens. */
  c?: number;
  /** Declared input modalities. */
  i?: readonly string[];
  /** Declared output modalities. */
  o?: readonly string[];
  /** Per 1M tokens: input, output, cache read, cache write. */
  p?: readonly number[];
};

export type ModelMetaMap = Record<string, ModelMeta>;

/** The price fields, in the order `p` stores them. */
const priceKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export type PriceField = (typeof priceKeys)[number];

export type ModelFacets = {
  displayName?: string;
  contextWindow?: number;
  inputModalities: string[];
  outputModalities: string[];
  prices: Partial<Record<PriceField, number>>;
  /** True when the provider stated at least one price. */
  hasPricing: boolean;
  /**
   * True only when the provider stated a price and every stated price is zero. A model
   * with no price at all is `undefined`, never free.
   */
  isFree?: boolean;
  acceptsImage: boolean;
  outputsImage: boolean;
};

const imageModalities = new Set(['image', 'image_url', 'images', 'vision']);

/** Reads a model's catalog metadata into something a filter can use. */
export function modelFacets(meta: ModelMeta | undefined): ModelFacets {
  const prices: Partial<Record<PriceField, number>> = {};
  if (meta?.p) {
    for (const [index, key] of priceKeys.entries()) {
      const value = meta.p[index];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) prices[key] = value;
    }
  }
  const stated = Object.keys(prices).length > 0;
  const inputModalities = [...(meta?.i ?? [])];
  const outputModalities = [...(meta?.o ?? [])];
  return {
    ...(meta?.n ? { displayName: meta.n } : {}),
    ...(meta?.c ? { contextWindow: meta.c } : {}),
    inputModalities,
    outputModalities,
    prices,
    hasPricing: stated,
    // Every stated price zero, and at least one stated. Anything else is unknown.
    ...(stated ? { isFree: Object.values(prices).every((value) => value === 0) } : {}),
    acceptsImage: inputModalities.some((modality) => imageModalities.has(modality.toLowerCase())),
    outputsImage: outputModalities.some((modality) => imageModalities.has(modality.toLowerCase())),
  };
}

export type ModalityFilter = 'any' | 'text' | 'image';
export type FreeFilter = 'any' | 'free' | 'priced' | 'unpriced';

export type ModelFilterState = {
  query: string;
  free: FreeFilter;
  modality: ModalityFilter;
  /** Minimum context window in tokens. 0 disables the filter. */
  minContext: number;
  result: 'all' | 'untested' | 'passed' | 'failed';
  sort: 'name' | 'cheapest' | 'fastest' | 'slowest' | 'widest';
};

export const defaultModelFilters: ModelFilterState = {
  query: '',
  free: 'any',
  modality: 'any',
  minContext: 0,
  result: 'all',
  sort: 'name',
};

/** Context thresholds worth offering, in tokens. */
export const contextOptions: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Any' },
  { value: 32_000, label: '32K+' },
  { value: 128_000, label: '128K+' },
  { value: 200_000, label: '200K+' },
  { value: 1_000_000, label: '1M+' },
];

/** A price as it should be read, or undefined when the provider did not quote one. */
export function priceLabel(prices: Partial<Record<PriceField, number>>, field: PriceField = 'input'): string | undefined {
  const value = prices[field];
  if (typeof value !== 'number') return undefined;
  if (value === 0) return 'Free';
  // Sub-cent prices are real and common; rounding them to $0.00 would read as free.
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function contextLabel(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/**
 * A model's test outcome, as the dashboard records it. Declared here so the filter
 * functions can be typed without the SDK depending on the dashboard.
 */
export type ModelTestState = 'idle' | 'testing' | 'ok' | 'error';

type Filterable = {
  model: string;
  facets: ModelFacets;
  testState: ModelTestState;
  latencyMs?: number;
};

/** Normalises a query the way a person types it: case- and separator-insensitive. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._/-]+/g, '');
}

function matchesQuery(model: string, facets: ModelFacets, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  // The display name is what a person recognises, so it is searched alongside the id.
  return normalize(model).includes(needle) || normalize(facets.displayName ?? '').includes(needle);
}

function matchesFree(facets: ModelFacets, free: FreeFilter): boolean {
  if (free === 'any') return true;
  if (free === 'free') return facets.isFree === true;
  if (free === 'priced') return facets.hasPricing && facets.isFree === false;
  return !facets.hasPricing;
}

function matchesModality(facets: ModelFacets, modality: ModalityFilter): boolean {
  if (modality === 'any') return true;
  // Unstated modalities cannot satisfy a modality filter. A provider that says nothing
  // about images has not been shown to lack them, so it is excluded rather than included.
  if (facets.inputModalities.length === 0) return false;
  if (modality === 'image') return facets.acceptsImage;
  return facets.inputModalities.includes('text') || facets.outputModalities.includes('text');
}

function matchesResult(testState: ModelTestState, result: ModelFilterState['result']): boolean {
  if (result === 'all') return true;
  // A model mid-test has no result yet, so it counts as untested rather than vanishing.
  if (result === 'untested') return testState === 'idle' || testState === 'testing';
  if (result === 'passed') return testState === 'ok';
  return testState === 'error';
}

/**
 * Sorts by a number, putting models with nothing to compare last in **both** directions.
 *
 * A column of blanks at the top of a "slowest first" list reads as a broken sort, which
 * is why this is explicit rather than relying on a sentinel: an infinite key sorts first
 * when the comparator is reversed.
 */
function byLatency<T extends { latencyMs?: number; model: string }>(models: T[], direction: 'asc' | 'desc'): T[] {
  const known = models.filter((entry) => typeof entry.latencyMs === 'number');
  const unknown = models.filter((entry) => typeof entry.latencyMs !== 'number');
  known.sort((left, right) =>
    direction === 'asc'
      ? (left.latencyMs ?? 0) - (right.latencyMs ?? 0) || left.model.localeCompare(right.model)
      : (right.latencyMs ?? 0) - (left.latencyMs ?? 0) || left.model.localeCompare(right.model),
  );
  return [...known, ...unknown.sort((left, right) => left.model.localeCompare(right.model))];
}

/** The blended price used for "cheapest", so a model is not free because input is. */
export function blendedPrice(prices: Partial<Record<PriceField, number>>): number | undefined {
  const input = prices.input;
  const output = prices.output;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  return input + output * 3;
}

export function applyModelFilters<T extends Filterable>(models: readonly T[], filters: ModelFilterState): T[] {
  const filtered = models.filter(
    (entry) =>
      matchesQuery(entry.model, entry.facets, filters.query) &&
      matchesFree(entry.facets, filters.free) &&
      matchesModality(entry.facets, filters.modality) &&
      (filters.minContext === 0 || (entry.facets.contextWindow ?? 0) >= filters.minContext) &&
      matchesResult(entry.testState, filters.result),
  );
  const sorted = [...filtered];
  switch (filters.sort) {
    case 'cheapest':
      sorted.sort((left, right) => {
        const a = blendedPrice(left.facets.prices);
        const b = blendedPrice(right.facets.prices);
        if (a === undefined && b === undefined) return left.model.localeCompare(right.model);
        if (a === undefined) return 1;
        if (b === undefined) return -1;
        return a - b || left.model.localeCompare(right.model);
      });
      break;
    case 'fastest':
      return byLatency(sorted, 'asc');
    case 'slowest':
      return byLatency(sorted, 'desc');
    case 'widest':
      sorted.sort((left, right) => (right.facets.contextWindow ?? 0) - (left.facets.contextWindow ?? 0) || left.model.localeCompare(right.model));
      break;
    default:
      sorted.sort((left, right) => left.model.localeCompare(right.model));
  }
  return sorted;
}

/**
 * Whether a filter can do anything on this provider, so the UI can say "this provider
 * publishes no prices" instead of offering a filter that silently matches nothing.
 */
export type FilterAvailability = {
  pricing: boolean;
  context: boolean;
  modalities: boolean;
  free: boolean;
};

export function filterAvailability(models: readonly { facets: ModelFacets }[]): FilterAvailability {
  const pricing = models.some((entry) => entry.facets.hasPricing);
  const context = models.some((entry) => entry.facets.contextWindow !== undefined);
  const modalities = models.some((entry) => entry.facets.inputModalities.length > 0 || entry.facets.outputModalities.length > 0);
  return { pricing, context, modalities, free: pricing };
}
