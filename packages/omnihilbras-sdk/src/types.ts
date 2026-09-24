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

export type ChatResponse = {
  id: string;
  providerId: ProviderId;
  model: string;
  createdAt: string;
  message: ChatMessage;
  finishReason: FinishReason;
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

export type Model = {
  id: string;
  providerId: ProviderId;
  displayName?: string;
  ownedBy?: string;
  contextWindow?: number;
  capabilities?: ProviderCapabilities;
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
