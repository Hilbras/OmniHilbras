import type { ProviderGroup, ProviderRecord, ProviderStatus } from '../components/ProviderCard';
import { PROVIDER_MANIFESTS } from '@omnihilbras/kernel-api/public';

export const providerLogoMap = {
  openai: '/providers/openai.png',
  anthropic: '/providers/anthropic.png',
  google: '/providers/gemini.png',
  ollama: '/providers/ollama.png',
  mistral: '/providers/mistral.png',
  openrouter: '/providers/openrouter.png',
  cline: '/providers/cline.png',
  chatgpt: '/providers/chatgpt.svg',
  deepseek: '/providers/deepseek.svg',
  qwen: '/providers/qwen.svg',
  kiro: '/providers/kiro.svg',
  opencode: '/providers/opencode.png',
  nara: '/providers/bynara-logo-icon-light.svg',
  tokenharbor: '/providers/tokenharbor.svg',
  xkiro: '/providers/xkiro-logo.svg',
  apmix: '/providers/apmix.png',
  apinex: '/providers/apinex.png',
  tiarina: '/providers/Tirina.png',
  // The free-tier wave (2026-11): the vendors' own marks, pulled from their sites and committed
  // here. Nous Research's mark is carried over from the reference project, which had it bundled —
  // the portal itself publishes no favicon — so no card in this group is left on its initial.
  'agnes-ai': '/providers/agnes-ai.png',
  agentrouter: '/providers/agentrouter.png',
  'aion-labs': '/providers/aion-labs.png',
  '100milionseek': '/providers/100milionseek.svg',
  nous: '/providers/nous.png',
  anyrouter: '/providers/anyrouter.png',
  beatapi: '/providers/beatapi.png',
  kiraai: '/providers/kiraai.png',
  vengetic: '/providers/vengetic.svg',
  zro: '/providers/zro.svg',
  unorouter: '/providers/unorouter.svg',
  // Added 1.43.0 with the ten API-key cards. Every path is a file already committed under
  // `public/providers/` — `tests/dashboard-assets.test.js` fails if a rendered mark is not, and 294
  // assets went missing from 18 releases once because a blanket staging rule excluded that directory.
  // No `initial` is doing the work of a logo here; these are the vendors' own marks.
  kimi: '/providers/kimi.svg',
  // The coding subscription is a separate product with its own mark, not the platform's.
  'kimi-code': '/providers/kimi-coding.png',
  // Claude Code is the Anthropic *subscription*, reached by OAuth — a separate account from the
  // metered `anthropic` API key. Its own card and its own mark, for the same reason `kimi-code` has.
  'claude-code': '/providers/claude.svg',
  // The `claude` authorization-code card signs in as the same vendor but keeps its own
  // connection; it shares the committed mark, not the Claude Code account.
  claude: '/providers/claude.svg',
  codex: '/providers/codex.svg',
  moonshot: '/providers/moonshot.svg',
  groq: '/providers/groq.svg',
  xai: '/providers/xai.svg',
  grok: '/providers/grok.svg',
  'grok-web': '/providers/grok-web.png',
  'perplexity-web': '/providers/perplexity-web.png',
  nvidia: '/providers/nvidia.svg',
  // Added 1.90.0 with the Qoder, Kilo Code, and MiniMax Code OAuth cards.
  qoder: '/providers/qoder.png',
  kilocode: '/providers/kilocode.png',
  'minimax-code': '/providers/minimax.png',
  'minimax-code-global': '/providers/minimax.png',
  // Added with the CodeBuddy cards: two regions, two accounts, two marks.
  'codebuddy-cn': '/providers/codebuddy-cn.png',
  'codebuddy-intl': '/providers/codebuddy-intl.png',
  coarena: '/providers/coarena.png',
  // ZCode's own mark, taken from the icon the installed ZCode app ships with
  // (`/usr/share/icons/hicolor/1024x1024/apps/zcode.png`) and committed here. The first version of
  // this file was pulled from zcode.z.ai, and it was not the app's mark — the card showed a logo the
  // product does not use.
  zcode: '/providers/zcode.png',
  // Numes' own mark, from the favicon it ships. SVG because no rasteriser is available here and the
  // catalogue already carries eighteen providers as SVG.
  numes: '/providers/numes.svg',
  // Parity-cycle keyed routers. Their marks are committed under `public/providers/` beside the
  // earlier ones; a card showing an initial here would be a missing mapping, not a missing asset.
  glm: '/providers/glm.png',
  'glm-cn': '/providers/glm-cn.png',
  together: '/providers/together.png',
  fireworks: '/providers/fireworks.svg',
  sambanova: '/providers/sambanova.svg',
  cerebras: '/providers/cerebras.svg',
  siliconflow: '/providers/siliconflow.png',
  nebius: '/providers/nebius.svg',
  perplexity: '/providers/perplexity.svg',
} as const;

export function getProviderLogo(id: string | null | undefined) {
  if (!id) return undefined;
  return providerLogoMap[id as keyof typeof providerLogoMap];
}

/**
 * The dashboard's provider cards, projected from the one manifest.
 *
 * The manifest is the source of the card, the tool capability row and the gateway's provider list.
 * This file no longer holds a second copy: changing a description, logo, auth label or capability is
 * an edit to `Kernel/SDK/_shared/src/provider-manifests.ts`, and all three surfaces move together.
 */
function toRecord(manifest: (typeof PROVIDER_MANIFESTS)[number]): ProviderRecord {
  return {
    id: manifest.id,
    ...(manifest.catalogId === undefined ? {} : { catalogId: manifest.catalogId }),
    ...(manifest.connectionProviderId === undefined ? {} : { connectionProviderId: manifest.connectionProviderId }),
    name: manifest.name,
    description: manifest.description,
    ...(manifest.freeTier === undefined ? {} : { freeTier: manifest.freeTier }),
    category: manifest.category,
    group: manifest.group as ProviderGroup,
    status: manifest.status as ProviderStatus,
    auth: manifest.auth,
    ...(manifest.authModes === undefined ? {} : { authModes: manifest.authModes as ProviderRecord['authModes'] }),
    models: manifest.models,
    latency: manifest.latency,
    requests: manifest.requests,
    lastUsed: manifest.lastUsed,
    health: manifest.health,
    ...(manifest.healthVerified === undefined ? {} : { healthVerified: manifest.healthVerified as ProviderRecord['healthVerified'] }),
    color: manifest.color,
    initial: manifest.initial,
    ...(manifest.logo === undefined ? {} : { logo: manifest.logo }),
    endpoint: manifest.endpoint ?? '',
    modelList: [...manifest.modelList],
    ...(manifest.riskNotice === undefined ? {} : { riskNotice: manifest.riskNotice }),
    ...(manifest.riskSeverity === undefined ? {} : { riskSeverity: manifest.riskSeverity as ProviderRecord['riskSeverity'] }),
    ...(manifest.unavailableReason === undefined ? {} : { unavailableReason: manifest.unavailableReason }),
    ...(manifest.apiKeysUrl === undefined ? {} : { apiKeysUrl: manifest.apiKeysUrl }),
  };
}

export const providerCatalog: ProviderRecord[] = PROVIDER_MANIFESTS.filter((manifest) => manifest.catalog).map(toRecord);

export function getProviderById(id: string | null | undefined) {
  if (!id) return undefined;
  return providerCatalog.find((provider) => provider.id === id || provider.catalogId === id);
}
