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
  xkiro: '/providers/xkiro-logo.svg',
  apmix: '/providers/apmix.png',
  tiarina: '/providers/Tirina.webp',
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
  moonshot: '/providers/moonshot.svg',
  groq: '/providers/groq.svg',
  xai: '/providers/xai.svg',
  grok: '/providers/grok.svg',
  nvidia: '/providers/nvidia.svg',
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
    /**
     * Not `planned` any more, and the distinction matters.
     *
     * `planned` meant "there is nothing behind this button", and the page disables it. That was
     * right while the only thing Qwen could be asked was a guess. There is now a flow behind it:
     * a probe that asks the real questions and reports the provider's own answers. A card with a
     * flow but no connection is `available` with `—` metrics — which is what the project rule
     * says — and the dialog is where the blocker is explained and testable.
     */
    status: 'available',
    /**
     * A caution, and a real one: this is a whole-account session, not a key scoped to inference.
     *
     * It was missing, which is not a cosmetic oversight. The connect dialog gates its textarea
     * on the acknowledgement, and renders the acknowledgement only when a notice exists — so a
     * provider without one got a permanently disabled field and no way to unlock it. The dialog's
     * own footer already says "treat this like a password", so it was promising a warning it had
     * no way to show.
     */
    riskNotice:
      'This is your Qwen account session, not an API key. Anyone holding it can act as you at chat.qwen.ai until it expires or you revoke it. OmniHilbras sends it only to your local gateway and stores it encrypted in the local vault; it never reaches browser storage.',
    riskSeverity: 'high',
    auth: 'Session cookie',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#615ced',
    initial: 'Q',
    logo: providerLogoMap.qwen,
    endpoint: 'https://chat.qwen.ai',
    /**
     * A dated snapshot of the guest catalog, not a promise.
     *
     * Read from `GET /api/v2/models/`, which answers guests. It has returned three here
     * consistently — and **seven** to someone running the probe minutes apart, with four extra
     * models, while repeated requests from here kept returning the same three. Cookies were
     * ruled out: none, `cna`, `isg` and a pasted pair all agreed. So the list moves, and the
     * connect dialog always shows the live one rather than this.
     *
     * No context window is claimed because Qwen publishes none on that endpoint.
     */
    modelList: ['qwen3.7-plus', 'qwen3.8-max', 'qwen3.8-omni-flash'],
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
    id: 'clinepass',
    name: 'ClinePass',
    description: 'Cline’s paid model tier — the same account as Cline, reached through the same sign-in. Its models need an active ClinePass subscription.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    /**
     * The **shared connection**. Cline's own auth registry registers `cline-pass` as an alias of the
     * `cline` handler reusing the identical stored credential, so both cards are served by the one
     * connection saved under `cline`. `providerCards.ts` merges on this, so naming the owner here is what
     * lights this card up from that connection — see also the gateway's `provider-alias.ts`. The adapter
     * id still travels as `clinepass`, so a failure names this card.
     */
    connectionProviderId: 'cline',
    logo: providerLogoMap.cline,
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#9d8df1',
    initial: 'C',
    endpoint: 'https://api.cline.bot/api/v1',
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
    // Placeholders, and they have to be placeholders. This catalog is the state a card shows when the
    // gateway has no connection for that provider — `ProvidersPage` seeds from it and
    // `mergeGatewayConnections` overlays only the providers that actually have one. So every number on
    // a card here is a number nobody measured.
    //
    // This card used to read `attention`, `6 models`, `92 ms`, `1,417` requests, `2 min ago`,
    // `health: 72`, and a three-model `modelList`. Every one of those was invented, left over from when
    // the dashboard was a static mockup, and a user with no Ollama connection was shown an amber
    // "attention" badge and a plausible week of traffic for a runtime they had never run. Twelve of the
    // thirteen cards already did the honest thing; this was the one that did not.
    //
    // When Ollama *is* connected, the real figures arrive from the gateway and overwrite all of this.
    // `tests/provider-cards.test.js` fails if a catalog card claims a measurement again.
    status: 'available',
    auth: 'No key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#e2bd52',
    initial: 'L',
    logo: providerLogoMap.ollama,
    endpoint: 'http://localhost:11434/v1',
    modelList: [],
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
    id: 'apmix',
    name: 'apmix',
    description:
      'One API key for GPT, Claude, Gemini, Grok, DeepSeek and Qwen, on a monthly allowance rather than per-token billing. OpenAI- and Anthropic-compatible. Key from apmix.ai.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#2563eb',
    initial: 'A',
    logo: providerLogoMap.apmix,
    endpoint: 'https://api.apmix.ai/v1',
    modelList: [],
  },
  {
    id: 'tiarina',
    name: 'Tiarina',
    description:
      'OpenAI-compatible gateway with a free tier on selected models. Key from the Tiarina dashboard.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#0f766e',
    initial: 'T',
    logo: providerLogoMap.tiarina,
    endpoint: 'https://ai.tiarina.cloud/v1',
    modelList: [],
  },
  {
    id: 'xkiro',
    name: 'xKiro',
    description:
      'One API key for 90+ models from 16 providers, through OpenAI- or Anthropic-compatible requests. Key from xkiro.com; 40+ models are listed as free.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#16a34a',
    initial: 'X',
    logo: providerLogoMap.xkiro,
    endpoint: 'https://api.xkiro.com/v1',
    modelList: [],
  },
  {
    /**
     * The **web** side of Token Harbor, as a separate card from the API-key one above — the same
     * split as Anthropic versus Claude Code, where the difference is the credential and not the
     * vendor.
     *
     * It drives the chat application at tokenharbor.ai with the Supabase session cookie a
     * signed-in browser already holds, instead of an API key. Token Harbor publishes a real API
     * (the card above), and their terms **prohibit** proxying the web chat — which is exactly what
     * this is — so it carries the strongest notice the catalog has and the trade is the user's.
     */
    id: 'tokenharbor-web',
    name: 'Token Harbor Web',
    description:
      'Drives tokenharbor.ai/chat with the session cookie you are signed in with. A web session, not your API key.',
    category: 'Web session',
    group: 'web-cookie',
    status: 'available',
    auth: 'Session cookie',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#3859ff',
    initial: 'T',
    logo: providerLogoMap.tokenharbor,
    endpoint: 'https://tokenharbor.ai',
    /**
     * An empty list on purpose, and not the same decision as the dated `qwen-web` snapshot.
     *
     * The models are real and known — 21 of them, including two `:free` ids that do not bill — but
     * they live in a constant in the adapter rather than on the card, because this catalog is the
     * no-connection fallback and must claim no measurement. The connect dialog is where the live
     * list is shown.
     */
    modelList: [],
    riskNotice:
      'Token Harbor is itself a gateway, and its terms prohibit constructing a proxy over it — which is what this is. Their documented, supported path is the API-key card beside this one, and a key is free on the ":free" models. This card drives the web chat with a live session cookie for a whole-account sign-in instead. Only continue if you have weighed that against the supported path.',
    riskSeverity: 'high',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    description: 'Moonshot AI long-context and agentic models, reached through their OpenAI-compatible endpoint.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#1f6feb',
    initial: 'K',
    logo: providerLogoMap.kimi,
    endpoint: 'https://api.moonshot.ai/v1',
    modelList: [],
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    description: 'Your Kimi Code subscription, signed in with the account you already have, rather than bought per token.',
    category: 'Model provider',
    group: 'oauth',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists.
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#1E3A8A',
    initial: 'KC',
    logo: providerLogoMap['kimi-code'],
    endpoint: 'https://api.kimi.com',
    modelList: [],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Your Claude Code subscription, signed in with the account you already have, rather than metered per token through an API key.',
    category: 'Model provider',
    group: 'oauth',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists.
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    // Anthropic's own terracotta, which is the accent the Claude app uses.
    color: '#d97757',
    initial: 'CC',
    logo: providerLogoMap['claude-code'],
    endpoint: 'https://api.anthropic.com',
    modelList: [],
    /**
     * Real, and the reason this is a separate card from `anthropic`.
     *
     * An `anthropic` card takes an API key metered per token. This card signs in with a Claude
     * subscription through OAuth, which Anthropic's consumer terms do not permit for third-party API
     * access. The user is the one who decides whether to make that trade, so both facts are on the card.
     */
    riskNotice:
      'Anthropic’s consumer terms do not permit using a Claude subscription for third-party API access. The credential here is an OAuth grant for your Claude account, not an API key. If you have an Anthropic API key, prefer the Anthropic card.',
    riskSeverity: 'standard',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models, served over the OpenAI-compatible API.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#4d6bfe',
    initial: 'D',
    logo: providerLogoMap.deepseek,
    endpoint: 'https://api.deepseek.com/v1',
    modelList: [],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    description: 'Alibaba Cloud Qwen models through the DashScope OpenAI-compatible mode.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#6f7cff',
    initial: 'Q',
    logo: providerLogoMap.qwen,
    endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    modelList: [],
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Groq LPU inference. Very fast first tokens, which is what a router wants most.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#f55036',
    initial: 'G',
    logo: providerLogoMap.groq,
    endpoint: 'https://api.groq.com/openai/v1',
    modelList: [],
  },
  {
    id: 'grok',
    name: 'Grok',
    description: 'xAI Grok models through the OpenAI-compatible endpoint.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#9c9584',
    initial: 'X',
    logo: providerLogoMap.grok,
    endpoint: 'https://api.x.ai/v1',
    modelList: [],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    description: 'NVIDIA NIM catalog of open models on its OpenAI-compatible endpoint.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#76b900',
    initial: 'N',
    logo: providerLogoMap.nvidia,
    endpoint: 'https://integrate.api.nvidia.com/v1',
    modelList: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models on the OpenAI API, including the Responses surface.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#6fdb9b',
    initial: 'O',
    logo: providerLogoMap.openai,
    endpoint: 'https://api.openai.com/v1',
    modelList: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models on the Anthropic API, on the Messages surface.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#d97757',
    initial: 'A',
    logo: providerLogoMap.anthropic,
    endpoint: 'https://api.anthropic.com/v1',
    modelList: [],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    description: 'Google Gemini models on the Generative Language API.',
    category: 'Model provider',
    group: 'api-key',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. `mergeGatewayConnections` overwrites every measured field once one exists, and
    // `tests/provider-cards.test.js` fails if a card here claims a measurement — see the Ollama entry
    // above for what that cost when one did.
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#83b7ff',
    initial: 'G',
    logo: providerLogoMap.google,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
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
