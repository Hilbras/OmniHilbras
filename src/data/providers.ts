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
  apinex: '/providers/apinex.png',
  tiarina: '/providers/Tirina.webp',
  // The free-tier wave (2026-11): the vendors' own marks, pulled from their sites and committed
  // here. Nous Research's mark is carried over from the reference project, which had it bundled —
  // the portal itself publishes no favicon — so no card in this group is left on its initial.
  'agnes-ai': '/providers/agnes-ai.png',
  agentrouter: '/providers/agentrouter.png',
  'aion-labs': '/providers/aion-labs.png',
  nous: '/providers/nous.png',
  anyrouter: '/providers/anyrouter.png',
  beatapi: '/providers/beatapi.webp',
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
    apiKeysUrl: 'https://chat.qwen.ai/',
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
    id: 'deepseek-web-v2',
    name: 'DeepSeek Web V2',
    description:
      'chat.deepseek.com with a sign-in that happens once, in a window of its own, and every request afterwards in the gateway — carrying the page’s own device fingerprints, the current client version and the server-delivered model catalogue. Separate from DeepSeek Web, which takes a pasted token.',
    category: 'Web session',
    group: 'v2-web',
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
    apiKeysUrl: 'https://chat.deepseek.com/',
    modelList: [],
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
    apiKeysUrl: 'https://chat.deepseek.com/',
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
    apiKeysUrl: 'https://kiro.dev/',
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
    endpoint: 'http://127.0.0.1:20138/v1',
    apiKeysUrl: 'https://app.cline.bot/',
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
    freeTier: "Models whose ID ends in -free cost nothing. They answer only requests sent from OpenCode's own client; other clients get a 403 FreeTierError. Paid models are not restricted.",
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    // Two ways in: a Console sign-in that yields a bearer the lane accepts, and a plain API key
    // from opencode.ai/auth. `authModes` is what the page reads; `auth` is what a person sees.
    auth: 'OAuth or API key',
    authModes: ['oauth', 'api-key'],
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#8b8f96',
    initial: 'Z',
    logo: providerLogoMap.opencode,
    endpoint: 'https://opencode.ai/zen/v1',
    apiKeysUrl: 'https://opencode.ai/auth',
    modelList: [],
  },
  {
    id: 'agnes-ai',
    name: 'Agnes AI',
    description: 'Free multimodal platform (text, image, video) behind one OpenAI-compatible API from the Agnes team. Key from platform.agnes-ai.com.',
    freeTier: 'Free to start; the platform reports its free tier serves trillions of API calls. Key from platform.agnes-ai.com.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['agnes-ai'],
    color: '#0ea5e9',
    initial: 'A',
    endpoint: 'https://apihub.agnes-ai.com/v1',
    apiKeysUrl: 'https://platform.agnes-ai.com/',
    modelList: [],
  },
  {
    id: 'agentrouter',
    name: 'AgentRouter',
    description: 'OpenAI- and Anthropic-compatible gateway for coding tools, with a free credit allowance and a model list that changes with capacity. Create a key in the AgentRouter console.',
    freeTier: 'Free credits for developers, and models that rotate with capacity. Check the console for the current model list and remaining quota.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap.agentrouter,
    color: '#f85ead',
    initial: 'A',
    endpoint: 'https://agentrouter.org/v1',
    apiKeysUrl: 'https://agentrouter.org/console/token',
    modelList: [],
  },
  {
    id: 'aion-labs',
    name: 'Aion Labs',
    description: 'OpenAI-compatible API for the Aion model family, built for long-form roleplay, storytelling and production writing. Key from the Aion Labs dashboard.',
    freeTier: 'Free tier: a daily credit allowance with 15 requests per minute and 20,000 tokens per minute, no card required.',
    category: 'Model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['aion-labs'],
    color: '#4eb4ff',
    initial: 'A',
    endpoint: 'https://api.aionlabs.ai/v1',
    apiKeysUrl: 'https://www.aionlabs.ai/app/api-keys/',
    modelList: [],
  },
  {
    id: 'nous',
    name: 'Nous Research',
    description: 'Nous Portal\u2019s OpenAI-compatible inference API: the Hermes series and hosted third-party models, keyed from portal.nousresearch.com or a Portal sign-in.',
    category: 'Model provider',
    group: 'free-tier',
    status: 'available',
    // Two ways in, and both are real flows: a Portal API key, or a device sign-in that mints an agent
    // key. `authModes` is what the page reads; `auth` is the string a person sees.
    auth: 'OAuth or API key',
    authModes: ['oauth', 'api-key'],
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap.nous,
    color: '#d97706',
    initial: 'N',
    endpoint: 'https://inference-api.nousresearch.com/v1',
    apiKeysUrl: 'https://portal.nousresearch.com/api-keys',
    modelList: [],
  },
  {
    id: 'numes',
    name: 'Numes',
    /**
     * The price is in the card because the group is not.
     *
     * `free-tier` holds relays and marketplaces as well as genuinely free services — BeatAPI and KiraAI
     * are already there — so this belongs beside them, but a person reading the group name should not be
     * surprised by a balance requirement either.
     */
    description:
      'An inference marketplace behind one OpenAI-compatible API: a single key reaches frontier APIs, OpenRouter and independent providers serving Ollama, vLLM or llama.cpp, with each request routed by live price, speed and reliability. **Paid per request** from a USD or BTC balance, and the balance must cover a request\'s cost hold before it runs — unlike the genuinely free cards in this group.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['numes'],
    color: '#d7ff01',
    initial: 'N',
    endpoint: 'https://api.numes.ai/api/v1',
    apiKeysUrl: 'https://numes.ai/dashboard/keys',
    modelList: [],
  },
  {
    id: 'beatapi',
    name: 'BeatAPI',
    description: 'OpenAI-compatible relay with chat, a responses lane and a /v1/usage credit report. The old project routed it at api.beatapi.io — that is the endpoint this card carries.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['beatapi'],
    color: '#ef4444',
    initial: 'B',
    endpoint: 'https://api.beatapi.io/v1',
    apiKeysUrl: 'https://beatapi.io/dashboard/apikeys',
    modelList: [],
  },
  {
    id: 'kiraai',
    name: 'KiraAI',
    description: 'KiraAI (Vietnam) model service: chat, image generations and audio speech over one keyed API. The old project routed it at kiraai.vn/api/v1 — that is the endpoint this card carries.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['kiraai'],
    color: '#22c55e',
    initial: 'K',
    endpoint: 'https://kiraai.vn/api/v1',
    apiKeysUrl: 'https://kiraai.vn/',
    modelList: [],
  },
  {
    id: 'vengetic',
    name: 'Vengetic',
    description: 'OpenAI-compatible relay at api.vengetic.biz.id.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['vengetic'],
    color: '#8b5cf6',
    initial: 'V',
    endpoint: 'https://api.vengetic.biz.id/v1',
    apiKeysUrl: 'https://api.vengetic.biz.id',
    modelList: [],
  },
  {
    id: 'anyrouter',
    name: 'AnyRouter',
    description: 'Free-credit OpenAI-compatible relay; migrating in is swapping the base URL and using an sk-ar- key from anyrouter.dev.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap.anyrouter,
    color: '#f59e0b',
    initial: 'A',
    endpoint: 'https://anyrouter.dev/api/v1',
    apiKeysUrl: 'https://anyrouter.dev/',
    modelList: [],
  },
  {
    id: 'zro',
    name: 'Zro',
    description: 'Zro relay by the Moonmath team. Its API surface is not publicly documented — the endpoint below is the conventional guess, and the save dialog lets you edit it if yours differs.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['zro'],
    color: '#14b8a6',
    initial: 'Z',
    endpoint: 'https://zro.moonmath.ai/v1',
    apiKeysUrl: 'https://zro.moonmath.ai',
    modelList: [],
  },
  {
    id: 'unorouter',
    name: 'UnoRouter',
    description: 'One key over OpenAI, Anthropic, Google, DeepSeek, Moonshot, Zhipu and Qwen models through an OpenAI-compatible endpoint.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    logo: providerLogoMap['unorouter'],
    color: '#6366f1',
    initial: 'U',
    endpoint: 'https://api.unorouter.com/v1',
    apiKeysUrl: 'https://api.unorouter.com/',
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
    id: 'opencode-go',
    name: 'OpenCode Go',
    description: 'The OpenCode team\u2019s subscription lane: a flat monthly plan over the same gateway, keyed from opencode.ai/auth.',
    // The subscription is the entitlement; the models behind it are the ones the plan carries, so the
    // card states the trade rather than a price that changes.
    freeTier: 'A monthly plan covers the models it lists \u2014 Kimi, GLM, Qwen, MiMo, MiniMax and the DeepSeek family on the fast lane \u2014 with rolling, weekly and monthly usage meters shown on the Usage tab.',
    category: 'Multi-model provider',
    group: 'api-key',
    status: 'available',
    auth: 'OAuth or API key',
    authModes: ['oauth', 'api-key'],
    models: '\u2014',
    latency: '\u2014',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#e87040',
    initial: 'G',
    logo: providerLogoMap.opencode,
    endpoint: 'https://opencode.ai/zen/go/v1',
    apiKeysUrl: 'https://opencode.ai/auth',
    modelList: [],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Efficient open and hosted models for fast, focused responses.',
    category: 'Multi-model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://console.mistral.ai/api-keys',
    modelList: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One connection for a broad catalog of hosted models and providers.',
    freeTier: 'Models with the :free suffix are free to call, with their own low rate limits. New accounts get a small free allowance, and buying credits raises the limits on free models.',
    category: 'Model catalog',
    group: 'free-tier',
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
    apiKeysUrl: 'https://openrouter.ai/keys',
    modelList: [],
  },
  {
    id: 'nara-router',
    name: 'NaraRouter',
    description: 'OpenAI-compatible router at router.bynara.id. Add an API key to serve its models here.',
    freeTier: 'A Free plan with a daily token cap and a requests-per-minute limit, and a set of free models that need no card. The exact caps are on the router.bynara.id pricing page.',
    category: 'Multi-model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://router.bynara.id/',
    modelList: [],
  },
  {
    id: 'tokenharbor',
    name: 'TokenHarbor',
    description:
      'Unified OpenAI-compatible gateway for GPT, Claude, Gemini and DeepSeek. Key from tokenharbor.ai/dashboard; selected models have a standing free tier.',
    freeTier: 'Selected models have a standing free tier. The models and limits are not published on the pages checked, so check the TokenHarbor dashboard for the current terms.',
    category: 'Multi-model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://tokenharbor.ai/dashboard',
    modelList: [],
  },
  {
    id: 'apmix',
    name: 'apmix',
    description:
      'One API key for GPT, Claude, Gemini, Grok, DeepSeek and Qwen, on a monthly allowance rather than per-token billing. OpenAI- and Anthropic-compatible. Key from apmix.ai.',
    freeTier: '3M free tokens on one model at sign-up. After that, usage is billed as a monthly allowance with per-model multipliers rather than per token.',
    category: 'Multi-model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://api.apmix.ai/',
    modelList: [],
  },
  {
    id: 'apinex',
    name: 'APInex',
    description:
      'One API key for OpenAI-compatible models, web research, Twitter/X and voice, with a single token balance. Key from apinex.bond.',
    freeTier: 'The free tier is not described on the pages checked. Check the APInex dashboard for current free-model terms.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#7c3aed',
    initial: 'A',
    logo: providerLogoMap.apinex,
    endpoint: 'https://api.apinex.bond/v1',
    apiKeysUrl: 'https://api.apinex.bond/',
    modelList: [],
  },
  {
    id: 'tiarina',
    name: 'Tiarina',
    description:
      'OpenAI-compatible gateway with a free tier on selected models. Key from the Tiarina dashboard.',
    freeTier: 'Selected models have a free tier. The models and limits are not published on the pages checked, so check the Tiarina dashboard for the current terms.',
    category: 'Multi-model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://ai.tiarina.cloud/',
    modelList: [],
  },
  {
    id: 'xkiro',
    name: 'xKiro',
    description:
      'One API key for 90+ models from 16 providers, through OpenAI- or Anthropic-compatible requests. Key from xkiro.com; 40+ models are listed as free.',
    freeTier: '40+ models are listed as free, and new accounts get free credits. The current limits are not published on the pages checked, so check xkiro.com.',
    category: 'Multi-model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://api.xkiro.com/',
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
    /**
     * Gemini Web — gemini.google.com driven in a real browser with your own session cookies.
     *
     * Distinct from the `gemini` card above, which is Google's Generative Language API with an API key.
     * Google publishes no endpoint that accepts a browser session, so this reaches the model the only way
     * that exists: load the page, let it solve its own challenges, type, and read the answer out of the
     * response the page makes for itself. `__Secure-1PSID` and `__Secure-1PSIDTS` are the credential.
     */
    id: 'gemini-web',
    name: 'Gemini Web',
    description:
      'Drives gemini.google.com in a browser using the session cookies you export yourself. The page is the client; there is no API behind this.',
    category: 'Web session',
    group: 'web-cookie',
    status: 'available',
    auth: 'Session cookie',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#4285f4',
    initial: 'G',
    logo: providerLogoMap.google,
    endpoint: 'https://gemini.google.com',
    apiKeysUrl: 'https://gemini.google.com/',
    modelList: [],
    /**
     * A live session for a whole Google account, and Google's terms.
     *
     * The credential is not scoped to inference: `__Secure-1PSID` is the cookie that keeps you signed in to
     * Google, and everything the person who exported it can do, it can do. Driving the page also means the
     * requests carry a browser, which is what Google's protections are there to notice. Both facts are the
     * user's to weigh, so both are on the card.
     */
    riskNotice:
      'This is a live session for your whole Google account — not a token limited to inference — and Google’s terms do not permit automating gemini.google.com. OmniHilbras loads the page in a real browser and lets it solve its own challenges. If you have a Gemini API key, the Gemini card beside this one is the supported path.',
    riskSeverity: 'high',
  },
  {
    id: 'duckduckgo-web',
    name: 'Duck.ai',
    description:
      'Duck.ai’s free model lineup, reached over its own chat endpoint behind an anti-bot challenge this gateway solves. No account and no cookie required.',
    category: 'Web session',
    group: 'web-cookie',
    // Placeholders, because this catalog is the state a card shows when the gateway has no connection
    // for the provider. The free lineup is real and read at connect time — six models, from each
    // model's own `accessTier` — but it lives in the adapter rather than here, because this catalog
    // must claim no measurement.
    status: 'available',
    auth: 'Session cookie',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#de5833',
    initial: 'D',
    logo: '/providers/duckai.png',
    endpoint: 'https://duck.ai',
    apiKeysUrl: 'https://duck.ai/',
    modelList: [],
    /**
     * A public, anonymous service — and the free tier is a courtesy, not a contract.
     *
     * The risk here is the opposite shape to the other web-session cards. Those hold a whole-account
     * session, and the warning is that the cookie is far more powerful than inference. Here there is no
     * cookie: the connection is stored with `{ type: 'none' }`, so there is no account to act as. What the
     * user is agreeing to instead is automated use of a service that serves signed-out visitors for
     * free and can rate-limit or withdraw that at any time — the `418` this provider answers with is the
     * visible form of it. So the notice says the two things that are true, and the dialog makes the
     * credential optional rather than implying one is needed.
     */
    riskNotice:
      'Duck.ai needs no account and no cookie — the connection is stored with no credential at all, so there is no signed-in session for OmniHilbras to act as. What you are agreeing to is automated use of a service that serves signed-out visitors for free. It can rate-limit or withdraw that at any time, and a refusal here (HTTP 418) means backing off, not a broken key. If you have an account with Duck.ai, connect through their own client instead.',
    riskSeverity: 'high',
  },
  {
    id: 'grok-web',
    name: 'Grok Web',
    description:
      'grok.com through the sso cookie a signed-in subscription holds. The web conversation endpoint, its model modes and the browser-fingerprint headers; not the xAI API key.',
    category: 'Web session',
    group: 'web-cookie',
    status: 'available',
    auth: 'Session cookie',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#1da1f2',
    initial: 'G',
    logo: providerLogoMap['grok-web'],
    endpoint: 'https://grok.com',
    apiKeysUrl: 'https://grok.com/',
    modelList: [],
    riskNotice:
      'This is a live session for your Grok subscription, not an inference token. Anyone holding the sso cookie can act as your account until it expires or you sign out, and grok.com’s terms may not permit automated access. OmniHilbras sends only the cookie and the web client’s own headers to grok.com. Use the xAI API-key Grok card if you want the supported path.',
    riskSeverity: 'high',
  },
  {
    id: 'perplexity-web',
    name: 'Perplexity Web',
    description:
      'perplexity.ai through the NextAuth session a signed-in Pro/Max account holds. The ask endpoint, its SSE blocks and the free and paid pplx models; not an API key.',
    category: 'Web session',
    group: 'web-cookie',
    status: 'available',
    auth: 'Session cookie',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#20808d',
    initial: 'P',
    logo: providerLogoMap['perplexity-web'],
    endpoint: 'https://www.perplexity.ai',
    apiKeysUrl: 'https://www.perplexity.ai/',
    modelList: [],
    riskNotice:
      'This is a live session for your Perplexity account, not a token scoped to inference. Anyone holding __Secure-next-auth.session-token can use the account until it expires or you sign out, and driving the web ask endpoint may conflict with Perplexity’s terms. OmniHilbras stores the cookie in the local vault and sends it only to perplexity.ai.',
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
    apiKeysUrl: 'https://platform.moonshot.ai/console/api-keys',
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
    apiKeysUrl: 'https://www.kimi.com/',
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
    apiKeysUrl: 'https://claude.ai/settings',
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
    id: 'codex',
    name: 'Codex',
    description:
      'Sign in with your ChatGPT account to serve Codex models through the subscription OAuth session. Works with no setup; see the card before you connect.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#10a37f',
    initial: 'C',
    logo: providerLogoMap.codex,
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    apiKeysUrl: 'https://chatgpt.com/',
    modelList: [],
    /**
     * Stated on the card because it is the user's trade to make, not ours to hide.
     *
     * With no local configuration this signs in through the public Codex CLI OAuth client, which
     * means the credential is a ChatGPT *subscription* session rather than an API key scoped to
     * inference. OpenAI does not license that session for proxy or router use, and an account
     * authorised this way can be restricted. Anyone who would rather not accept that can set
     * their own client ID and registered redirect URI; the card then says so instead.
     */
    riskNotice:
      'Sign-in uses your ChatGPT subscription session, not an API key — OpenAI does not license that session for proxy or router use, and an account connected this way can be restricted or banned. Out of the box it uses the public Codex CLI OAuth client. Set your own OMNIHILBRAS_CODEX_CLIENT_ID and registered redirect URI to avoid that default.',
    riskSeverity: 'high',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    description: 'Qoder AI coding assistant, signed in with your account to reach its tiered and frontier models.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#EC4899',
    initial: 'QO',
    logo: providerLogoMap.qoder,
    endpoint: 'https://api3.qoder.sh',
    apiKeysUrl: 'https://qoder.com/',
    modelList: [],
  },
  {
    id: 'kilocode',
    name: 'Kilo Code',
    description: 'Kilo Code AI coding assistant, signed in with a device code to reach its OpenRouter-backed catalog.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#FF6B35',
    initial: 'KC',
    logo: providerLogoMap.kilocode,
    endpoint: 'https://api.kilo.ai',
    apiKeysUrl: 'https://app.kilo.ai/',
    modelList: [],
  },
  {
    id: 'minimax-code',
    name: 'MiniMax Code',
    description: 'MiniMax Code agent, China region, signed in with your account to reach the MiniMax Code models.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#FF4D4F',
    initial: 'MM',
    logo: providerLogoMap['minimax-code'],
    endpoint: 'https://agent.minimax.cn',
    apiKeysUrl: 'https://platform.minimaxi.com/',
    modelList: [],
  },
  {
    id: 'minimax-code-global',
    name: 'MiniMax Code (Global)',
    description: 'MiniMax Code agent, international region, signed in with your account to reach the MiniMax Code models.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#FF4D4F',
    initial: 'MG',
    logo: providerLogoMap['minimax-code-global'],
    endpoint: 'https://agent.minimax.io',
    apiKeysUrl: 'https://platform.minimax.io/',
    modelList: [],
  },
  {
    // Two regions, two accounts, two domains. The same split as MiniMax Code above, and for the same
    // reason: a sign-in on one side does not reach the other, so one card could not describe both.
    id: 'codebuddy-cn',
    name: 'CodeBuddy',
    description: 'CodeBuddy, China region, signed in with your account to reach its GLM, Kimi, DeepSeek and MiniMax models.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#006EFF',
    initial: 'CB',
    logo: providerLogoMap['codebuddy-cn'],
    endpoint: 'https://copilot.tencent.com',
    apiKeysUrl: 'https://www.codebuddy.ai/',
    modelList: [],
  },
  {
    id: 'codebuddy-intl',
    name: 'CodeBuddy (Global)',
    description: 'CodeBuddy, international region, signed in with your account to reach the same model catalog on codebuddy.ai.',
    category: 'Coding agent',
    group: 'oauth',
    status: 'available',
    auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#006EFF',
    initial: 'CG',
    logo: providerLogoMap['codebuddy-intl'],
    endpoint: 'https://www.codebuddy.ai',
    modelList: [],
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
    apiKeysUrl: 'https://platform.deepseek.com/api_keys',
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
    apiKeysUrl: 'https://dashscope.console.aliyun.com/',
    modelList: [],
  },
  {
    id: 'qwen-token-plan',
    name: 'Qwen (Token Plan)',
    description: 'Alibaba Cloud Qwen models through the QwenCloud Token Plan OpenAI-compatible mode.',
    category: 'Model provider',
    group: 'api-key',
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
    endpoint: 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1',
    apiKeysUrl: 'https://console.qwencloud.com/',
    modelList: [],
  },
  {
    id: 'zcode',
    name: 'ZCode (Start Plan)',
    description: 'Your ZCode Start Plan account (GLM-5.3 / GLM-5.3-Flash), reached through its Anthropic-compatible endpoint. Paste the access token from the ZCode desktop app.',
    category: 'Model provider',
    group: 'oauth',
    // Placeholders, because this is the state the card shows when the gateway has no connection for it.
    status: 'available',
    // The standalone sign-in: ZCode's own OAuth server, the same flow the desktop app uses for a CLI.
  // `POST /v1/oauth/zcode/start` mints it, the browser signs in, and the dialog polls until the
  // gateway has saved the account's JWT. Nothing is read from the installed app and nothing is pasted.
  auth: 'OAuth',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#3563e9',
    initial: 'Z',
    logo: providerLogoMap.zcode,
    endpoint: 'https://zcode.z.ai',
    modelList: [],
    riskNotice:
      'This is an unofficial interoperability surface for a ZCode Start Plan account, not a Z.ai API key. The token is your signed-in ZCode session; use it only for the account you are authorized to use.',
    riskSeverity: 'standard',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Groq LPU inference. Very fast first tokens, which is what a router wants most.',
    category: 'Model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://console.groq.com/keys',
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
    apiKeysUrl: 'https://console.x.ai/',
    modelList: [],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    description: 'NVIDIA NIM catalog of open models on its OpenAI-compatible endpoint.',
    category: 'Model provider',
    group: 'free-tier',
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
    apiKeysUrl: 'https://build.nvidia.com/',
    modelList: [],
  },
  {
    id: 'coarena',
    name: 'Coarena',
    description: 'OpenAI-compatible gateway to 22 models (Claude, GPT, Gemini, Grok, Kimi, Qwen, DeepSeek and more) with a free daily allowance paid by Coarena.',
    freeTier: 'Free: $5 of model use a day, paid by Coarena. 30 requests a minute, 2 concurrent. Limits and usage shown via /api/v1/limits.',
    category: 'Multi-model provider',
    group: 'free-tier',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#6366f1',
    initial: 'C',
    logo: providerLogoMap.coarena,
    endpoint: 'https://coarena.ai/api/v1',
    apiKeysUrl: 'https://coarena.ai/account/api',
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
    apiKeysUrl: 'https://platform.openai.com/api-keys',
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
    apiKeysUrl: 'https://console.anthropic.com/settings/keys',
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
    apiKeysUrl: 'https://aistudio.google.com/apikey',
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
