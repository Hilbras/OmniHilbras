import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";

/**
 * Operator-set output ceiling.
 *
 * The translators call adjustMaxTokens() without any settings access — they are
 * pure functions of the body. Rather than thread a settings object through every
 * translator, chatCore sets this for the duration of one request (see
 * withOutputCap below) and the translators read it here.
 *
 * 0 / null means "no operator cap": the model's own ceiling applies, as before.
 */
let operatorCeiling = 0;
let operatorThinkingCeiling = 0;

/** The cap currently in force (0 = none). Exported for tests and diagnostics. */
export function getOperatorMaxTokens() {
  return operatorCeiling;
}

/** The thinking-budget cap currently in force (0 = none). */
export function getOperatorThinkingBudget() {
  return operatorThinkingCeiling;
}

/**
 * Run `fn` with operator output/thinking caps in force, then restore the
 * previous ones.
 *
 * Synchronous by design: translation is synchronous, so the caps are never
 * visible to another request's translation on the same thread. Restoring in a
 * finally keeps a translator that throws from leaking them.
 */
export function withOutputCap(cap, fn, thinkingCap = 0) {
  const previous = operatorCeiling;
  const previousThinking = operatorThinkingCeiling;
  const next = Number(cap);
  const nextThinking = Number(thinkingCap);
  operatorCeiling = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
  operatorThinkingCeiling = Number.isFinite(nextThinking) && nextThinking > 0 ? Math.floor(nextThinking) : 0;
  try {
    return fn();
  } finally {
    operatorCeiling = previous;
    operatorThinkingCeiling = previousThinking;
  }
}

/**
 * Adjust max_tokens based on request context
 * @param {object} body - Request body
 * @param {number} [ceiling=DEFAULT_MAX_TOKENS] - Upper bound for max_tokens.
 *   Callers with model context (e.g. openai-to-claude) pass the model's real
 *   maxOutput so high-output models (Opus 4.8 = 128000) aren't pre-clamped to
 *   the conservative 64000 default before the model-aware step sees them.
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body, ceiling = DEFAULT_MAX_TOKENS) {
  let maxTokens = body.max_tokens || DEFAULT_MAX_TOKENS;

  // Auto-increase for tool calling to prevent truncated arguments (min never above max)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (maxTokens < DEFAULT_MIN_TOKENS) {
      maxTokens = DEFAULT_MIN_TOKENS;
    }
  }

  // Ensure max_tokens > thinking.budget_tokens (Claude API requirement)
  // Claude API requires strictly greater, so add buffer instead of using the
  // ceiling which could equal budget_tokens when budget_tokens >= ceiling
  if (body.thinking?.budget_tokens && maxTokens <= body.thinking.budget_tokens) {
    maxTokens = body.thinking.budget_tokens + 1024;
  }

  // Never exceed the ceiling
  if (maxTokens > ceiling) maxTokens = ceiling;

  // The operator's cap wins over the model ceiling: it is an explicit spend
  // decision, and a provider that would happily emit 128k tokens is exactly
  // what the operator is trying to bound.
  if (operatorCeiling > 0 && maxTokens > operatorCeiling) maxTokens = operatorCeiling;

  return maxTokens;
}

/**
 * Clamp an explicit thinking budget to the operator's cap.
 *
 * Returns the budget to use (or the input when no cap applies). Kept separate
 * from adjustMaxTokens because a thinking budget is a different knob on a
 * different field, and Claude requires max_tokens > budget_tokens — the caller
 * re-derives max_tokens after clamping.
 */
export function clampThinkingBudget(budgetTokens) {
  const budget = Number(budgetTokens);
  if (!Number.isFinite(budget) || budget <= 0) return budgetTokens;
  if (operatorThinkingCeiling > 0 && budget > operatorThinkingCeiling) return operatorThinkingCeiling;
  return budgetTokens;
}
