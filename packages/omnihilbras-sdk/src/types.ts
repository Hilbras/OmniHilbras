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
  signal?: AbortSignal;
  requestId?: string;
};

export type ProviderHealth = {
  status: 'healthy' | 'degraded' | 'unavailable';
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
  /** Performs a provider-specific, side-effect-free credential check. */
  validateCredential?: (credential: ProviderCredential | undefined, context?: ProviderRequestContext) => Promise<CredentialValidation | void>;
  /** Discovers models for a connection import policy. */
  discoverModels?: (context: ProviderRequestContext | undefined, options: ModelImportOptions) => Promise<readonly Model[]>;
  healthCheck?: (context?: ProviderRequestContext) => Promise<ProviderHealth>;
};
