import type { TokenUsage } from './types.js';

/** The wire fields the four provider families actually report. */
export type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cachedContentTokenCount?: number;
  reasoning_tokens?: number;
  thoughtsTokenCount?: number;
  total_tokens?: number;
  totalTokenCount?: number;
  estimated?: boolean;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
  input_tokens_details?: { cached_tokens?: number; reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * One usage convention for storage and cost.
 *
 * Claude reports a prompt that **excludes** cache, with cache read/write as separate fields; OpenAI and
 * Gemini report cached tokens **inside** the prompt. Storing both shapes unchanged is how a cached request
 * gets charged twice or not at all. The result follows the old gateway's convention:
 *
 *   inputTokens        = total input, including cache read/write
 *   cacheReadTokens    = cache-read subset
 *   cacheWriteTokens   = cache-write subset
 *   outputTokens       = completion/visible output
 *   reasoningTokens    = reasoning subset of output (kept separately for display)
 *
 * Idempotent: an already-canonical object carries `cached_tokens`-free numbers and `cacheReadTokens`, so
 * re-running takes the pass-through branch.
 */
export function canonicalizeUsage(raw: RawUsage | undefined): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const cacheRead = num(
    raw.cacheReadTokens
    ?? raw.cache_read_input_tokens
    ?? raw.cached_tokens
    ?? raw.cachedContentTokenCount
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.input_tokens_details?.cached_tokens,
  );
  const cacheWrite = num(
    raw.cacheWriteTokens
    ?? raw.cache_creation_input_tokens
    ?? raw.prompt_tokens_details?.cache_creation_tokens,
  );
  const baseInput = num(
    raw.inputTokens
    ?? raw.prompt_tokens
    ?? raw.input_tokens
    ?? raw.promptTokenCount,
  );
  // Claude-shaped input excludes cache; the fields are present. OpenAI/Gemini already include it.
  const claudeShaped = raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined;
  const inputTokens = claudeShaped ? baseInput + cacheRead + cacheWrite : baseInput;
  const outputTokens = num(raw.outputTokens ?? raw.completion_tokens ?? raw.output_tokens ?? raw.candidatesTokenCount);
  const reasoningTokens = num(
    raw.reasoningTokens
    ?? raw.reasoning_tokens
    ?? raw.thoughtsTokenCount
    ?? raw.output_tokens_details?.reasoning_tokens
    ?? raw.input_tokens_details?.reasoning_tokens,
  );
  if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(raw.estimated === true ? { estimated: true } : {}),
  };
}
