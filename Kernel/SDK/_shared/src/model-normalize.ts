import type { Model, ModelPricing } from './types.js';

/**
 * Lossless catalog normalization for OpenAI-shaped provider responses.
 *
 * Every field here is set only when the provider's own catalog stated it: no default context window,
 * no inferred modality, no invented price. A free model's zero stays a real zero, and a missing price
 * dimension stays missing rather than collapsing into another one.
 */

type Raw = Record<string, unknown>;

const record = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const number = (...values: unknown[]): number | undefined => values.find((value) => typeof value === 'number' && Number.isFinite(value) && (value as number) >= 0) as number | undefined;
const strings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim());
  return list.length ? list : undefined;
};
const date = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value * 1000).toISOString();
  const raw = text(value);
  if (raw && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  return undefined;
};
/** Providers quote either per-token or per-1M, often as strings. Values under 1 (except zero) are per-token. */
const per1M = (value: unknown, perToken: boolean): number | undefined => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  const amount = typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  if (amount === undefined) return undefined;
  return perToken && amount > 0 && amount < 1 ? Math.round(amount * 1_000_000 * 1e6) / 1e6 : amount;
};

function pricingFrom(value: unknown, perToken: boolean): ModelPricing | undefined {
  if (value === undefined) return undefined;
  const price = record(value);
  const top = record(price.top_provider);
  const usage = record(price.usage);
  const pricing: ModelPricing = {};
  const input = per1M(price.prompt ?? price.input ?? price.input_cost ?? usage.prompt_tokens, perToken);
  const output = per1M(price.completion ?? price.output ?? price.output_cost ?? usage.completion_tokens, perToken);
  const cacheRead = per1M(price.input_cache_read ?? price.cache_read ?? price.cached ?? top.cached_tokens, perToken);
  // Providers call this field cache_write or cache_creation; the canonical name is cacheWritePer1M.
  const cacheWrite = per1M(price.input_cache_write ?? price.cache_write ?? price.cache_creation, perToken);
  const reasoning = per1M(price.reasoning ?? price.output_reasoning, perToken);
  if (input !== undefined) pricing.inputPer1M = input;
  if (output !== undefined) pricing.outputPer1M = output;
  if (cacheRead !== undefined) pricing.cacheReadPer1M = cacheRead;
  if (cacheWrite !== undefined) pricing.cacheWritePer1M = cacheWrite;
  if (reasoning !== undefined) pricing.reasoningPer1M = reasoning;
  return Object.keys(pricing).length ? pricing : undefined;
}

function reasoningFrom(value: unknown): Model['reasoning'] | undefined {
  const source = record(value);
  if (!Object.keys(source).length) return undefined;
  const efforts = strings(source.supported_efforts ?? source.efforts);
  const effort = text(source.default_effort ?? source.effort);
  const out: NonNullable<Model['reasoning']> = {};
  if (typeof source.enabled === 'boolean') out.defaultEnabled = source.enabled;
  if (typeof source.default === 'boolean') out.defaultEnabled = source.default;
  if (source.mandatory === true || source.required === true) out.mandatory = true;
  if (effort) out.defaultEffort = effort;
  if (efforts) out.supportedEfforts = efforts;
  return Object.keys(out).length ? out : undefined;
}

/** Maps one raw catalog entry to the fields the provider actually stated. */
export function normalizeCatalogModel(value: unknown, providerId: string): Model {
  const raw = record(value);
  const architecture = record(raw.architecture);
  const top = record(raw.top_provider);
  const limit = record(raw.limit);
  const contextWindow = number(raw.context_length, raw.context_window, raw.max_context_length, raw.max_context_window, top.context_length, limit.context);
  const maxOutputTokens = number(top.max_completion_tokens, raw.max_output_tokens, raw.max_completion_tokens, limit.output);
  const modalities = record(raw.modalities);
  const inputModalities = strings(raw.input_modalities ?? architecture.input_modalities ?? modalities.input)
    ?? (typeof architecture.modality === 'string' && architecture.modality ? [architecture.modality] : undefined);
  const outputModalities = strings(raw.output_modalities ?? architecture.output_modalities ?? modalities.output);
  // `pricing` is the OpenRouter/OpenAI per-token shape; `cost` is OpenCode Console's per-1M shape.
  // Some catalogs (notably NVIDIA's) state capability flags explicitly. Only a `true` is a fact;
  // absence stays absent rather than becoming `false` with a meaning nobody stated.
  const capabilities: Model['capabilities'] = {
    // An explicit false is a statement by the provider, not an absent opinion: narrowing a
    // tools-capable provider to one model that cannot call tools needs the false to survive here.
    ...(raw.supports_tools === false ? { tools: false } : (raw.supports_tools === true ? { tools: true } : {})),
    ...(raw.supports_thinking === false ? { reasoning: false } : (raw.supports_thinking === true ? { reasoning: true } : {})),
  };
  const pricing = pricingFrom(raw.pricing ?? raw.cost, raw.pricing !== undefined);
  return {
    id: text(raw.id) ?? '',
    providerId: providerId as Model['providerId'],
    ...(text(raw.display_name) || text(raw.name) ? { displayName: text(raw.display_name) ?? text(raw.name) } : {}),
    ...(text(raw.owned_by) ? { ownedBy: text(raw.owned_by) } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(text(raw.description) ? { description: text(raw.description) } : {}),
    ...(strings(raw.aliases) ? { aliases: strings(raw.aliases) } : {}),
    ...(date(raw.created) ? { createdAt: date(raw.created) } : {}),
    ...(text(raw.knowledge_cutoff) ? { knowledgeCutoff: text(raw.knowledge_cutoff) } : {}),
    ...(date(raw.expiration_date ?? raw.expires_at) ? { expiresAt: date(raw.expiration_date ?? raw.expires_at) } : {}),
    ...(text(raw.status) ? { status: text(raw.status) } : {}),
    ...(text(raw.canonical_slug) ? { canonicalSlug: text(raw.canonical_slug) } : {}),
    ...(text(architecture.tokenizer) ? { tokenizer: text(architecture.tokenizer) } : {}),
    ...(strings(raw.supported_parameters) ? { supportedParameters: strings(raw.supported_parameters) } : {}),
    ...(text(raw.model_type) ? { modelType: text(raw.model_type) } : {}),
    ...(capabilities && Object.keys(capabilities).length ? { capabilities } : {}),
    ...(reasoningFrom(raw.reasoning) ? { reasoning: reasoningFrom(raw.reasoning) } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(pricing ? { pricing } : {}),
    source: 'provider',
  };
}
