import type { ProviderRecord } from '../components/ProviderCard';

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
} as const;

export function getProviderLogo(id: string | null | undefined) {
  if (!id) return undefined;
  return providerLogoMap[id as keyof typeof providerLogoMap];
}

export const providerCatalog: ProviderRecord[] = [
  {
    id: 'opencode-console',
    name: 'OpenCode Console',
    description:
      'Sign in to your OpenCode Console account. This is the credential that reaches Zen’s free models — an API key alone is refused by every lane.',
    category: 'Multi-model provider',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#e87040',
    initial: 'O',
    logo: providerLogoMap.opencode,
    endpoint: 'https://opencode.ai/inference/openai/v1',
    modelList: [],
  },
  {
    id: 'chatgpt-web',
    name: 'ChatGPT Web',
    description:
      'Drives chatgpt.com in a browser using a session you export yourself. Answers are read out of the page.',
    category: 'Web session',
    group: 'web-cookie',
    status: 'available',
    auth: 'Web cookie',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#10a37f',
    initial: 'C',
    logo: providerLogoMap.chatgpt,
    endpoint: 'https://chatgpt.com',
    modelList: [],
    /**
     * Not a preference, and not the ordinary sort of credential warning.
     *
     * There is no ChatGPT API that accepts a browser session, so reaching a model this way
     * means loading chatgpt.com in a real browser and letting its own page solve the
     * anti-automation challenges. The credential is a live session for a whole OpenAI
     * account rather than a token scoped to inference, and OpenAI's terms do not permit
     * this. Both facts are on the card because both are the user's to weigh.
     */
    riskNotice:
      'OpenAI’s terms do not permit automating chatgpt.com, and the credential here is a live session for your whole account — not a token limited to inference. OmniHilbras opens chatgpt.com in a browser and lets its page solve the anti-bot challenges. Only continue if that is a trade you have decided to make.',
    riskSeverity: 'high',
  },
  {
    id: 'qwen-web',
    name: 'Qwen Web',
    description:
      'chat.qwen.ai through a browser session. The models are readable; the turn is not — see the card.',
    category: 'Web session',
    group: 'web-cookie',
    /**
     * Catalogued, not connected, and the card says so rather than implying otherwise.
     *
     * `qwen3.7-plus`, `qwen3.8-max` and `qwen3.8-omni-flash` are all real: the models endpoint
     * answers an unauthenticated guest with 200 and a million tokens of context each. The chat
     * endpoint is a plain, unminified `POST /api/v2/chat/completions`.
     *
     * The turn is refused by Alibaba's TMD anti-bot, which answers 200 with a captcha that has
     * to be rendered in a browser, and a guest session has no XSRF cookie to send. So there is
     * nothing to connect to *yet*, and the honest state is that rather than a button which
     * opens a dialog that cannot work.
     */
    status: 'planned',
    auth: 'Not yet available',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#615ced',
    initial: 'Q',
    logo: providerLogoMap.qwen,
    endpoint: 'https://chat.qwen.ai',
    modelList: [],
    /** Why it is not built, in one sentence a user can act on. */
    unavailableReason:
      'Models are served to guests, but every turn is refused by Alibaba’s bot-protection gate (RGV587_ERROR). Visiting the challenge it hands back grants no cookie and the retry is refused identically, so it is a human puzzle rather than a clearance flow. Needs a signed-in Qwen session; not built on a maybe — see docs/SPEC-SDK.md.',
  },
  {
    id: 'deepseek-web',
    name: 'DeepSeek Web',
    description:
      'chat.deepseek.com through the session you sign in with. Plain HTTP behind a userToken — no browser in the request path.',
    category: 'Web session',
    group: 'web-cookie',
    status: 'available',
    auth: 'Web session',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#4d6bfe',
    initial: 'D',
    logo: providerLogoMap.deepseek,
    endpoint: 'https://chat.deepseek.com',
    modelList: [],
    /**
     * Real, and worth reading before connecting.
     *
     * DeepSeek publishes an official API and this is not it. The credential is a `userToken`
     * from a signed-in web session, which is a live session for a whole account rather than a
     * token scoped to inference, and using it means sending DeepSeek's own web-client
     * fingerprint so the requests are not trivially distinguishable from the site's.
     *
     * Also worth saying plainly: DeepSeek gates every completion with a proof of work, and
     * solving it is what OmniHilbras does in `deepseek-pow.ts`. That is a bounded search
     * (~250k hashes at worst), not a wall, but it is a real cost on every request.
     */
    riskNotice:
      'DeepSeek publishes an official API, and this is not it. The credential is a userToken from your signed-in chat.deepseek.com session — a live session for a whole account, not a token limited to inference — and requests carry DeepSeek\'s own web-client fingerprint. Every completion is also gated by a proof of work that OmniHilbras solves. If you have an API key, prefer it.',
    riskSeverity: 'standard',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    description:
      'Sign in with your AWS Builder ID. Serves Claude, GPT, DeepSeek, MiniMax and GLM through Kiro’s plan.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#9046ff',
    initial: 'K',
    logo: providerLogoMap.kiro,
    endpoint: 'https://codewhisperer.us-east-1.amazonaws.com',
    modelList: [],
    // Not a preference. Kiro's terms prohibit third-party proxy and harness use, and
    // this is exactly that, so the card says so before anyone connects rather than in a
    // release note afterwards.
    riskNotice:
      'Kiro’s terms prohibit third-party proxy or harness use. Connecting routes your AWS Builder ID session through OmniHilbras — accept that risk or do not connect.',
  },
  {
    id: 'cline',
    name: 'Cline',
    description: 'VS Code coding agent. Sign in with your Cline account to serve its models here.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#7cc7a1',
    initial: 'C',
    logo: providerLogoMap.cline,
    endpoint: 'http://127.0.0.1:8787/v1',
    modelList: [],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    description: 'Curated gateway from the OpenCode team. Sign in at opencode.ai/auth for a key; you are charged per request.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#8b8f96',
    initial: 'Z',
    logo: providerLogoMap.opencode,
    endpoint: 'https://opencode.ai/zen/v1',
    modelList: [],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Private local inference for coding models and offline development.',
    category: 'Local runtime',
    group: 'local',
    status: 'attention',
    auth: 'No key',
    models: '6 models',
    latency: '92 ms',
    requests: '1,417',
    lastUsed: '2 min ago',
    health: 72,
    color: '#e2bd52',
    initial: 'L',
    logo: providerLogoMap.ollama,
    endpoint: 'http://localhost:11434/v1',
    modelList: ['qwen3-coder', 'llama3.2', 'nomic-embed-text'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Efficient open and hosted models for fast, focused responses.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#f97316',
    initial: 'M',
    logo: providerLogoMap.mistral,
    endpoint: 'https://api.mistral.ai/v1',
    modelList: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One connection for a broad catalog of hosted models and providers.',
    category: 'Model catalog',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#b995e8',
    initial: 'R',
    logo: providerLogoMap.openrouter,
    endpoint: 'https://openrouter.ai/api/v1',
    modelList: [],
  },
  {
    id: 'nara-router',
    name: 'NaraRouter',
    description: 'OpenAI-compatible router at router.bynara.id. Add an API key to serve its models here.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#2d3948',
    initial: 'N',
    logo: providerLogoMap.nara,
    endpoint: 'https://router.bynara.id/v1',
    modelList: [],
  },
  {
    id: 'tokenharbor',
    name: 'TokenHarbor',
    description:
      'Unified OpenAI-compatible gateway for GPT, Claude, Gemini and DeepSeek. Key from tokenharbor.ai/dashboard; selected models have a standing free tier.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    // Taken from their own stylesheet. They publish no theme-color, and the terracotta
    // on the page belongs to an Anthropic section they embed, not to them.
    color: '#3859ff',
    initial: 'T',
    logo: providerLogoMap.tokenharbor,
    endpoint: 'https://tokenharbor.ai/v1',
    modelList: [],
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    description: 'Connect any OpenAI-compatible gateway, proxy, or local server.',
    category: 'Custom endpoint',
    group: 'custom',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#9c9584',
    initial: 'C',
    endpoint: 'http://localhost:8000/v1',
    modelList: [],
  },
];

export function getProviderById(id: string | null | undefined) {
  if (!id) return undefined;
  return providerCatalog.find((provider) => provider.id === id || provider.catalogId === id);
}
