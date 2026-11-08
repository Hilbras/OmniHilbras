/**
 * The prefix a model id carries, per provider: `<slug>/<model>`.
 *
 * Each slug is fixed by hand and kept here, rather than computed from the title at runtime. A title can be
 * renamed on a card, and a model id built from it would then change under every saved client. A slug only
 * changes in a release, and only on purpose.
 *
 * ## Short is the rule now
 *
 * Every provider gets a short prefix — two or three characters — because these ids are typed, pasted into
 * client configs and read in a model list a hundred times a day. `opencode-zen/big-pickle` became
 * `opz/big-pickle`.
 *
 * ## One prefix, one provider
 *
 * A prefix must belong to exactly one provider, or a request cannot be routed. `kc` was asked for twice
 * (Kimi Code and Kilo Code); Kimi Code keeps it and Kilo Code takes `klc`, because the two are the pair a
 * reader is most likely to confuse and a silent collision would send one product's request to the other.
 * `kimi` and `kimi-code`, `qwen` and `qwen-web`, `gemini` and `gemini-web`, `tokenharbor` and
 * `tokenharbor-web` are separated the same way.
 *
 * ## Old ids keep routing
 *
 * `LEGACY_SLUGS` holds prefixes this table used to hand out. `splitProviderPrefix` matches the provider's
 * id, its slug, or a legacy slug, so a client that saved `opencode-zen/...` before the rename still
 * resolves — only the ids the gateway *publishes* change. Every provider whose old slug was its own id
 * needs no entry: the id is matched already.
 */
export const PROVIDER_SLUGS: Readonly<Record<string, string>> = {
  // ── OAuth subscriptions ────────────────────────────────────────────────────
  'opencode-console': 'opc',
  kiro: 'kr',
  cline: 'cl',
  clinepass: 'clp',
  'kimi-code': 'kc',
  'claude-code': 'cc',
  codex: 'cd',
  qoder: 'qd',
  // Not `kc`: taken by Kimi Code, and a collision here would route one product's model to the other.
  kilocode: 'klc',
  'minimax-code': 'mc',
  'minimax-code-global': 'mcg',
  'codebuddy-cn': 'cb',
  'codebuddy-intl': 'cbg',
  // ── Web sessions ──────────────────────────────────────────────────────────
  'chatgpt-web': 'cgw',
  'qwen-web': 'qw',
  'deepseek-web': 'dsw',
  'tokenharbor-web': 'thw',
  'gemini-web': 'gmw',
  'duckduckgo-web': 'ddw',
  // ── Free tier ─────────────────────────────────────────────────────────────
  opencode: 'opz',
  // The subscription lane of the same product: `ocg`, the alias the reference project uses.
  'opencode-go': 'ocg',
  'agnes-ai': 'ag',
  nous: 'ns',
  beatapi: 'bt',
  kiraai: 'ka',
  vengetic: 'vg',
  anyrouter: 'ar',
  zro: 'zro',
  unorouter: 'ur',
  mistral: 'mst',
  openrouter: 'or',
  'nara-router': 'nr',
  tokenharbor: 'th',
  apmix: 'amx',
  apinex: 'apx',
  tiarina: 'tr',
  xkiro: 'xk',
  groq: 'gq',
  nvidia: 'nv',
  // ── Local, and the metered API keys ───────────────────────────────────────
  ollama: 'ol',
  kimi: 'km',
  deepseek: 'ds',
  qwen: 'qn',
  grok: 'gk',
  openai: 'oa',
  anthropic: 'an',
  gemini: 'gm',
  custom: 'ce',
};

/**
 * Prefixes this table used to publish, by provider, so a saved client keeps resolving.
 *
 * Only providers whose old slug differed from **both** their id and their new slug need an entry; the id
 * is matched on its own, which covers the majority.
 */
export const LEGACY_SLUGS: Readonly<Record<string, readonly string[]>> = {
  opencode: ['opencode-zen'],
  'nara-router': ['nararouter'],
  'tokenharbor-web': ['token-harbor-web'],
  custom: ['custom-endpoint'],
};

/** The prefix for a provider id: its fixed slug, or the id itself when the table has no entry. */
export function providerSlug(providerId: string): string {
  return PROVIDER_SLUGS[providerId] ?? providerId;
}

/** The current prefix plus any it replaced, for resolving a model id a client already saved. */
export function providerPrefixes(providerId: string): readonly string[] {
  const legacy = LEGACY_SLUGS[providerId];
  return legacy ? [providerSlug(providerId), ...legacy] : [providerSlug(providerId)];
}

/** A model id as clients see it: `<slug>/<model>`. */
export function qualifiedModelId(providerId: string, modelId: string): string {
  return `${providerSlug(providerId)}/${modelId}`;
}