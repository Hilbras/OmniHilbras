export type ProviderId = string;

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other';

export type TextContentPart = {
  type: 'text';
  text: string;
};

export type ImageContentPart = {
  type: 'image_url';
  imageUrl: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
};

export type MessageContentPart = TextContentPart | ImageContentPart;

export type MessageContent = string | readonly MessageContentPart[] | null;

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolCallDelta = {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type ChatMessage = {
  role: ChatRole;
  content: MessageContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly ToolCall[];
};

export type ChatRequest = {
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stop?: readonly string[];
  stream?: boolean;
  tools?: readonly ToolDefinition[];
  providerOptions?: Record<string, unknown>;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/**
 * A cost the provider reports in something other than tokens.
 *
 * Kiro meters credits and publishes no token counts. Without a place to carry that, the
 * only options are dropping it — which makes a metered call look free — or reporting it
 * as zero tokens, which is a different and equally false claim.
 */
export type Meters = {
  unit: string;
  amount: number;
};

export type ChatResponse = {
  id: string;
  providerId: ProviderId;
  model: string;
  createdAt: string;
  message: ChatMessage;
  finishReason: FinishReason;
  usage?: TokenUsage;
  /** Set when the provider meters this call in something other than tokens. */
  meters?: Meters;
  /** Share of the context window the provider reports as used, 0–100. */
  contextUsagePercent?: number;
};

/**
 * One input, and the vector the provider returned for it.
 *
 * **`dimensions` is the provider's own answer, or absent — never a default.**
 *
 * This is the rule the whole embeddings surface turns on. A missing `dimensions` field used to be the
 * tempting place to write `1536`, because every OpenAI-shaped model returns 1536 and a client that
 * hardcodes it looks right until it talks to a provider that returns 3072. A caller cannot recover from
 * a wrong number after the fact: the vector is already built, and a caller who trusted `1536` has no
 * way to notice. So `undefined` means *the provider did not say*, and it is carried to the response
 * rather than resolved to a guess.
 */
export type EmbeddingVector = {
  index: number;
  embedding: readonly number[];
  /** What the provider reported, when it reported one. Absent means unknown, not zero. */
  dimensions?: number;
};

/**
 * A request for embeddings. The shape OpenAI's `/v1/embeddings` already uses.
 *
 * `input` is deliberately `string | readonly string[]` rather than token arrays: this SDK has never
 * tokenised, and an adapter that needs to will tokenise provider-side. Accepting an integer-token form
 * would imply a tokenizer this package does not have and silently produce different vectors than the
 * caller expects.
 */
export type EmbeddingRequest = {
  /** The model to embed with, named exactly as the provider names it. */
  readonly model: string;
  readonly input: string | readonly string[];
  /** Passed through as `dimensions` where the provider accepts one. */
  readonly dimensions?: number;
  /** The OpenAI `encoding_format`. Only `float` is supported; see the adapter. */
  readonly encodingFormat?: 'float';
  readonly user?: string;
};

export type EmbeddingResponse = {
  id: string;
  providerId: ProviderId;
  model: string;
  createdAt: string;
  data: readonly EmbeddingVector[];
  usage?: TokenUsage;
};

export type ChatChunk = {
  id: string;
  providerId: ProviderId;
  model: string;
  delta: {
    role?: ChatRole;
    content?: string;
    toolCalls?: readonly ToolCallDelta[];
  };
  finishReason?: FinishReason;
  usage?: TokenUsage;
};

/**
 * Prices are normalised to **per 1M tokens** because that is the unit a person compares.
 * Providers disagree: OpenRouter quotes per-token strings (`"0.0000025"`), OpenCode
 * Zen quotes per-1M numbers (`2.5`). Converting at the edge means the dashboard never has
 * to know which provider it is looking at.
 */
export type ModelPricing = {
  inputPer1M?: number;
  outputPer1M?: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
};

export type Model = {
  id: string;
  providerId: ProviderId;
  displayName?: string;
  ownedBy?: string;
  contextWindow?: number;
  capabilities?: ProviderCapabilities;
  /**
   * Declared modalities, e.g. `['text']` or `['text', 'image', 'pdf']`. Only present
   * when the provider's catalog states them; a minimal OpenAI-compatible catalog says
   * nothing, and an absent list must not be read as "text only".
   */
  inputModalities?: readonly string[];
  outputModalities?: readonly string[];
  pricing?: ModelPricing;
};

export type ProviderCapability =
  | 'chat'
  | 'streaming'
  | 'models'
  | 'embeddings'
  | 'images'
  | 'audio'
  | 'search';

export type ProviderCapabilities = Partial<Record<ProviderCapability, boolean>>;

export type ProviderCredential =
  | { type: 'api-key'; value: string }
  /**
   * A token obtained through an OAuth authorization-code flow. `value` is the
   * current access token; `refreshToken` and `expiresAt` let an adapter renew it
   * without asking the user to sign in again.
   */
  /**
   * `orgId` and `orgName` are set by providers that scope a session to an
   * organization and expect it echoed on every request, such as OpenCode Console.
   */
  /**
   * `oauthClientId` / `oauthClientSecret` are the dynamically registered client a grant was
   * issued to. AWS binds a refresh token to that client and answers `invalid_client` for any
   * other pair, so an adapter that renews by OAuth has to carry it.
   */
  | { type: 'oauth'; value: string; refreshToken?: string; expiresAt?: string; email?: string; orgId?: string; orgName?: string; accountId?: string; oauthClientId?: string; oauthClientSecret?: string }
  | { type: 'none' };

export type ProviderRequestContext = {
  credential?: ProviderCredential;
  /** The connection's model import policy, so a provider can narrow its own list. */
  importPolicy?: ModelImportPolicy;
  signal?: AbortSignal;
  requestId?: string;
};

/**
 * What a health check actually established.
 *
 * ## Why this exists
 *
 * Two OpenCode connections both reported `healthy` while **no model on either could serve a single
 * request** — measured:
 *
 * ```
 * opencode (Zen API key)         free models  403  FreeTierError: free tier needs the OpenCode client
 *                                qwen3.8-max  402  Insufficient account funds
 * opencode-console (OAuth)       free models  403  FreeTierError
 *                                gpt-5-mini   400  Model is unavailable
 * ```
 *
 * Neither was lying about what it checked. Both asked "does this credential exist and can it read the
 * catalog?", got yes, and returned `healthy` — a word that means *this route can serve traffic*. The
 * check was cheap and correct; the **name of the answer** was the defect. This is the shape of the
 * Check button fixed in 1.35.0 and the health manager's own note in `apps/gateway/src/health.ts`
 * ("a check that proved nothing"): the question was not asked, and nothing said so.
 *
 * ## Why not simply send a real request
 *
 * Because it would be wrong in a different direction. A health poll runs every 60 seconds across every
 * adapter, so a real completion per poll is a real bill for every user, on every minute, to answer a
 * question that changes hourly at most. The SDK says so where the decision was made:
 *
 * > A signed-in probe would cost a billable request on every health poll, so the credential is checked
 * > for presence and shape only.
 *
 * And for these two providers it could not even work: every free model is refused outright and the paid
 * ones need account funds, so a probing request would report a working credential as a broken one.
 *
 * So the check stays free, and reports its own scope. `credential` means the credential is present and
 * the catalog is readable; `inference` means a request actually completed. Omitting the field is not
 * allowed — a health verdict that does not say what it established is the defect this type closes.
 */
export type HealthVerification = 'credential' | 'inference';

export type ProviderHealth = {
  status: 'healthy' | 'degraded' | 'unavailable';
  /**
   * What the check established. Required, because a verdict without it claims more than it knows.
   *
   * `healthy` with `credential` means "this route is authenticated", **not** "this route can serve".
   * A consumer that needs the stronger claim has to make a request.
   */
  verified: HealthVerification;
  latencyMs?: number;
  message?: string;
  checkedAt: string;
};

export type ModelImportPolicy = 'free' | 'all';

export type ModelImportOptions = {
  policy: ModelImportPolicy;
};

export type CredentialValidation = {
  status: 'valid';
  checkedAt: string;
  latencyMs?: number;
};

export type ProviderAdapter = {
  readonly id: ProviderId;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  listModels?: (context?: ProviderRequestContext) => Promise<readonly Model[]>;
  chat?: (request: ChatRequest, context?: ProviderRequestContext) => Promise<ChatResponse>;
  streamChat?: (request: ChatRequest, context?: ProviderRequestContext) => AsyncIterable<ChatChunk>;
  /**
   * Embeds text, when this adapter's provider can.
   *
   * **Optional, and optional is the point.** A published interface gains a member by adding it as
   * optional; adding it as required would break every adapter that cannot serve it, every consumer that
   * implements the interface, and would make "this provider has no embeddings endpoint" a *compile*
   * error rather than a truthful runtime one.
   *
   * An adapter without `embed` is not broken and must not be reported as unavailable. `notSupported()`
   * in `apps/gateway/src/capability.ts` produces `NOT_SUPPORTED` naming the adapter, which is the
   * message a user needs — the two situations look identical from outside and mean opposite things to
   * act on.
   */
  embed?: (request: EmbeddingRequest, context?: ProviderRequestContext) => Promise<EmbeddingResponse>;
  /** Performs a provider-specific, side-effect-free credential check. */
  validateCredential?: (credential: ProviderCredential | undefined, context?: ProviderRequestContext) => Promise<CredentialValidation | void>;
  /** Discovers models for a connection import policy. */
  discoverModels?: (context: ProviderRequestContext | undefined, options: ModelImportOptions) => Promise<readonly Model[]>;
  healthCheck?: (context?: ProviderRequestContext) => Promise<ProviderHealth>;
  /**
   * Whether a stored credential is already known to have expired, answered **without a request**.
   *
   * Optional, and the point of it is cost. Every credential this SDK stores carries an expiry, and
   * before this, three of the five kinds discovered it by *asking the provider* — which for a
   * ChatGPT Web connection means launching a browser, on every health sweep, to be told something
   * the credential already said in writing.
   *
   * So: an adapter whose credential states when it ends implements this, and the gateway skips the
   * round trip. An adapter that cannot say — an API key with no expiry — leaves it out and behaves
   * exactly as before.
   *
   * It is a *pre*-check and not a replacement for `healthCheck`. A credential that is not expired may
   * still be revoked, so the network check still happens; this only answers the question that
   * needs no network.
   *
   * Three answers, not two, and the third is the load-bearing one. `true` means *definitely*
   * expired. `false` means definitely not. `undefined` means **the adapter cannot say** — no
   * expiry, an unreadable one, a credential shape it does not recognise — and the gateway then asks
   * the provider.
   *
   * It started as a plain boolean and that was wrong, because `false` from an adapter that does not
   * know is indistinguishable from `false` from one that does. Every uncertainty has to resolve
   * towards "go and ask", because the two ways of being wrong cost very differently: a needless
   * request, or a working connection ejected.
   */
  isCredentialExpired?: (credential: ProviderCredential | undefined, now?: number) => boolean | undefined;
};
