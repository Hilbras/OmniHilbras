/**
 * The prefix a model id carries, per provider: `<slug>/<model>`.
 *
 * Each slug is fixed by hand from the provider's title and kept here, rather than computed from the title at
 * runtime. A title can be renamed on a card, and a model id built from it would then change under every saved
 * client. A slug only changes in a release, and only on purpose.
 *
 * A provider missing from this table falls back to its id, so a new provider is never given an empty prefix.
 */
const PROVIDER_SLUGS: Readonly<Record<string, string>> = {
  'opencode-console': 'opencode-console',
  'chatgpt-web': 'chatgpt-web',
  'qwen-web': 'qwen-web',
  'deepseek-web': 'deepseek-web',
  kiro: 'kiro',
  cline: 'cline',
  clinepass: 'clinepass',
  opencode: 'opencode-zen',
  ollama: 'ollama',
  mistral: 'mistral',
  openrouter: 'openrouter',
  'nara-router': 'nararouter',
  tokenharbor: 'tokenharbor',
  apmix: 'apmix',
  apinex: 'apinex',
  tiarina: 'tiarina',
  xkiro: 'xkiro',
  'tokenharbor-web': 'token-harbor-web',
  kimi: 'kimi',
  'kimi-code': 'kimi-code',
  'claude-code': 'claude-code',
  deepseek: 'deepseek',
  qwen: 'qwen',
  groq: 'groq',
  grok: 'grok',
  nvidia: 'nvidia',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  custom: 'custom-endpoint',
};

/** The prefix for a provider id: its fixed slug, or the id itself when the table has no entry. */
export function providerSlug(providerId: string): string {
  return PROVIDER_SLUGS[providerId] ?? providerId;
}

/** A model id as clients see it: `<slug>/<model>`. */
export function qualifiedModelId(providerId: string, modelId: string): string {
  return `${providerSlug(providerId)}/${modelId}`;
}
