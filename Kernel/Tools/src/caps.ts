import type { ToolChoice } from './types.js';

/**
 * Which providers serve tools, and how far `tool_choice` can be pushed.
 *
 * ## Why one table in one package
 *
 * The alternative is 29 vendors of the same decision, each a `capabilities` field in a package that cannot see its
 * neighbours. That is how the state this table records came about: `anthropic/lib/types.ts` declared `toolChoice` and
 * no adapter code ever sent Anthropic's `tool_choice`; Gemini did not mention it at all; `codex` refused tools outright;
 * and the web adapters dropped them without a word. Nothing compared the claims, so nothing disagreed out loud.
 *
 * `tests/tools-caps.test.js` is what keeps this from being fiction: it drives every adapter with a scripted transport
 * and asserts the body the adapter actually built, so a row that says `required` is a row that was seen sending one.
 *
 * ## What the modes mean
 *
 * - `required` in the list — the adapter maps a forced call onto that provider's own wire shape.
 * - `required` absent — the provider accepts tools, but cannot be told to call one. Asking is a stated refusal, not a
 *   silent downgrade, because a client that asked for a forced call and got prose has been lied to about its request.
 * - `tools: false` — tools do not reach the model at all. `web: true` marks the cookie/browser providers, which are
 *   excluded from the tool contract on purpose: they are a page being driven, not an API with a function-calling
 *   surface, and pretending otherwise was the earlier plan's mistake.
 */

export type ToolCaps = {
  tools: boolean;
  toolChoice: readonly ToolChoice[];
  /** A cookie/browser session rather than an API. Named so the surfaces can say "not supported" rather than "broken". */
  web: boolean;
  /** The row was missing and a conservative default was used. False for every provider in a released build. */
  assumed?: boolean;
};

/**
 * OpenAI-shaped wires: `tool_choice` goes through as `auto | none | required`.
 *
 * Two kinds live here. The first are providers with an adapter that speaks the OpenAI wire directly. The second are the
 * catalogue's API-key routers (`agnes-ai`, `agentrouter`, `numes`, …): they are served by the same generic
 * OpenAI-compatible adapter with a different base URL, so they inherit its wire rather than needing a row of their own
 * *implementation* — only a row of their own *name*, so that adding one without a decision still fails the guard.
 */
const OPENAI_WIRE = [
  'openai',
  'openrouter',
  'openai-compatible',
  'apmix',
  'beatapi',
  'cline',
  'clinepass',
  'nous',
  'agnes-ai',
  'agentrouter',
  'aion-labs',
  '100milionseek',
  'anyrouter',
  'apinex',
  'coarena',
  'custom',
  'cerebras',
  'deepseek',
  'glm',
  'glm-cn',
  'mimo-free',
  'groq',
  'grok',
  'kimi',
  'kiraai',
  'mistral',
  'nara-router',
  'nebius',
  'nvidia',
  'numes',
  'perplexity',
  'ollama',
  'qwen',
  'qwen-token-plan',
  'sambanova',
  'siliconflow',
  'tiarina',
  'together',
  'fireworks',
  'tokenharbor',
  'unorouter',
  'vengetic',
  'xkiro',
  'zro',
] as const;

/** Their own wire, with a mapping this repository wrote and tests assert. */
const FORCED_WITH_MAPPING = ['anthropic', 'gemini', 'codebuddy-cn', 'codebuddy-intl', 'kilocode', 'minimax-code', 'minimax-code-global', 'zcode'] as const;

/**
 * Tools work; forcing does not.
 *
 * These accept tools but cannot be told to force one, so `tool_choice: "required"` is refused by name rather than
 * forwarded and ignored. Two providers left this set in phase 3: `anthropic`, which already mapped `required` to
 * `{type:"any"}` and was simply mislabelled by a grep that missed its mapping function, and `gemini`, which had no
 * mapping at all until `toolConfig.functionCallingConfig.mode` was added.
 */
/**
 * OpenCode's lanes accept tools but their free tier dictates `auto`/`none`: a forced call was refused
 * only after the request reached the adapter, and routing treats that refusal as terminal. Saying so
 * here makes the edge refuse by name before a provider is called, which is the project's stated rule.
 */
const NO_FORCING = ['claude', 'claude-code', 'kimi-code', 'kiro', 'qoder', 'opencode', 'opencode-go', 'opencode-console', 'codex', 'xai'] as const;

/** Codex serves real function calls on its Responses wire; it simply cannot be told to force one. */

/** Cookie/browser sessions. No tools, by contract — see the module comment. */
export const WEB_PROVIDERS = [
  'chatgpt-web',
  'gemini-web',
  'duckduckgo-web',
  'deepseek-web',
  'deepseek-web-v2',
  'tokenharbor-web',
  'grok-web',
  'perplexity-web',
  'qwen-web',
] as const;

function build(): Record<string, ToolCaps> {
  const table: Record<string, ToolCaps> = {};
  const forced: readonly ToolChoice[] = ['auto', 'none', 'required'];
  const neutral: readonly ToolChoice[] = ['auto', 'none'];
  for (const id of [...OPENAI_WIRE, ...FORCED_WITH_MAPPING]) {
    table[id] = { tools: true, toolChoice: forced, web: false };
  }
  for (const id of NO_FORCING) table[id] = { tools: true, toolChoice: neutral, web: false };
  for (const id of WEB_PROVIDERS) table[id] = { tools: false, toolChoice: [], web: true };
  return table;
}

export const PROVIDER_TOOLS: Readonly<Record<string, ToolCaps>> = Object.freeze(build());

/** Every provider id this table names. The guard compares it against catalogue cards and gateway registrations. */
export function toolProviderIds(): readonly string[] {
  return Object.keys(PROVIDER_TOOLS);
}

/**
 * The capability row for a provider.
 *
 * An unknown id answers conservatively — tools pass through, forcing does not — and says `assumed: true` so the
 * caller can report it. It does not throw: a provider shipped a release ahead of its row must still serve, and the
 * guard test is what stops that from being the normal case rather than an incident.
 */
export function toolCaps(providerId: string): ToolCaps {
  const row = PROVIDER_TOOLS[providerId];
  if (row) return row;
  return { tools: true, toolChoice: ['auto', 'none'], web: false, assumed: true };
}
