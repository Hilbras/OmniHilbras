import { ProviderError } from '../errors.js';
import { FetchHttpTransport } from '../transport.js';
import type { HttpTransport } from '../transport.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, FinishReason, MessageContent, Model, ProviderAdapter, ProviderCredential, ProviderRequestContext, TokenUsage } from '../types.js';

/**
 * Kiro.
 *
 * Kiro signs in through AWS SSO's OIDC device flow rather than a provider-specific one,
 * and once signed in it is not an OpenAI-compatible endpoint at all: it is CodeWhisperer's
 * streaming service, which takes a `conversationState` envelope and answers with an AWS
 * eventstream. So there is no generic adapter to point at this, and the translation below
 * is the whole integration.
 *
 * The auth half is a public OAuth client registered on demand, so nothing secret is
 * embedded here — the same shape as the OpenCode Console device flow.
 */
export const KIRO = {
  /** AWS SSO OIDC, where the device flow lives. */
  oidc: 'https://oidc.us-east-1.amazonaws.com',
  clientName: 'kiro-oauth-client',
  clientType: 'public',
  scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
  grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c',
  /** Where the user approves the device. */
  startUrl: 'https://view.awsapps.com/start',
  /** CodeWhisperer's streaming service, which is what actually answers. */
  inferenceUrl: 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
  streamingTarget: 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
  userAgent: 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
  amzUserAgent: 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
  eventStreamAccept: 'application/vnd.amazon.eventstream',
} as const;

export const kiroProviderId = 'kiro';

/**
 * Kiro's catalog. Ids must match its upstream exactly — an unknown id is refused with
 * `400 Invalid model. Please select a different model`, and there is no wildcard or
 * `auto` id to fall back on.
 */
export const KIRO_MODELS: ReadonlyArray<{ id: string; name: string; contextWindow?: number; maxOutputTokens?: number }> = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 64_000 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxOutputTokens: 64_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 272_000, maxOutputTokens: 128_000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272_000, maxOutputTokens: 128_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272_000, maxOutputTokens: 128_000 },
  { id: 'deepseek-3.2', name: 'DeepSeek V3.2' },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
  { id: 'minimax-m2.1', name: 'MiniMax M2.1' },
  { id: 'glm-5', name: 'GLM-5' },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' },
];

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export type KiroDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  /** Absolute, because AWS returns this relative on some regions. */
  verificationUrl: string;
  intervalSeconds: number;
  expiresIn?: number;
  clientId: string;
  clientSecret: string;
};

type Json = Record<string, unknown>;

/**
 * OAuth token endpoints are read directly rather than through the provider transport.
 *
 * The transport deliberately flattens an error body into a human sentence, and for a
 * device grant the machine token *is* the state: AWS answers a pending poll with
 * `400 {"error":"authorization_pending","error_description":"Authorization is still
 * pending"}`, and the flattened detail keeps only the description, so the grant reads as
 * a failure. Inference still goes through the transport, where that flattening is what we
 * want.
 */
async function postAuthJson<T>(url: string, body: Json): Promise<{ status: number; data: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: T;
  try {
    data = (text ? JSON.parse(text) : {}) as T;
  } catch {
    data = { error: 'invalid_response', error_description: text.slice(0, 200) } as unknown as T;
  }
  return { status: response.status, data };
}

/** Registers the public client the device flow needs. Nothing secret is embedded. */
export async function registerKiroClient(): Promise<{ clientId: string; clientSecret: string }> {
  const { data } = await postAuthJson<Json>(`${KIRO.oidc}/client/register`, {
    clientName: KIRO.clientName,
    clientType: KIRO.clientType,
    scopes: [...KIRO.scopes],
    grantTypes: [...KIRO.grantTypes],
    issuerUrl: KIRO.issuerUrl,
  });
  const clientId = typeof data.clientId === 'string' ? data.clientId : '';
  const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret : '';
  if (!clientId || !clientSecret) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'AWS did not return a client registration for Kiro.', {
      providerId: kiroProviderId,
      publicMessage: 'AWS did not return a client registration for Kiro. Try again in a moment.',
    });
  }
  return { clientId, clientSecret };
}

/** Asks AWS for a device code the user approves in a browser. */
export async function beginKiroSignIn(): Promise<KiroDeviceAuthorization> {
  const { clientId, clientSecret } = await registerKiroClient();
  // AWS refuses the request without the start URL, answering
  // `400 Start URL is required`, so it is part of the grant rather than a preference.
  const { data } = await postAuthJson<Json>(`${KIRO.oidc}/device_authorization`, { clientId, clientSecret, startUrl: KIRO.startUrl });
  const deviceCode = typeof data.deviceCode === 'string' ? data.deviceCode : '';
  const userCode = typeof data.userCode === 'string' ? data.userCode : '';
  if (!deviceCode || !userCode) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'AWS did not return a Kiro device code.', {
      providerId: kiroProviderId,
      publicMessage: 'AWS did not return a Kiro device code. Try again in a moment.',
    });
  }
  const verificationUri = typeof data.verificationUri === 'string' ? data.verificationUri : KIRO.startUrl;
  return {
    deviceCode,
    userCode,
    // AWS returns this relative on some regions, so it is joined rather than shown bare.
    verificationUrl: verificationUri.startsWith('http') ? verificationUri : `https://view.awsapps.com${verificationUri.startsWith('/') ? '' : '/'}${verificationUri}`,
    intervalSeconds: typeof data.interval === 'number' ? data.interval : 5,
    clientId,
    clientSecret,
    ...(typeof data.expiresIn === 'number' ? { expiresIn: data.expiresIn } : {}),
  };
}

export type KiroPoll =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | { status: 'connected'; accessToken: string; refreshToken?: string; expiresIn?: number; profileArn?: string };

/**
 * Polls for the token. A pending answer is HTTP 400 with `authorization_pending` in the
 * body, so the status is read from the payload rather than treated as a failure.
 */
export async function pollKiroSignIn(
  authorization: Pick<KiroDeviceAuthorization, 'deviceCode' | 'clientId' | 'clientSecret'>,
): Promise<KiroPoll> {
  const { data } = await postAuthJson<Json>(`${KIRO.oidc}/token`, {
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    deviceCode: authorization.deviceCode,
    clientId: authorization.clientId,
    clientSecret: authorization.clientSecret,
  });

  // A pending grant is HTTP 400 with the state in the body, so the body decides.
  const error = typeof data.error === 'string' ? data.error : '';
  if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
  if (error) {
    const description = typeof data.error_description === 'string' ? data.error_description : '';
    return { status: 'denied', error: description || `AWS reported ${error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}.` };
  }
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!accessToken) {
    return { status: 'denied', error: 'AWS returned a Kiro session with no access token. Start again.' };
  }
  return {
    status: 'connected',
    accessToken,
    ...(typeof data.refreshToken === 'string' ? { refreshToken: data.refreshToken } : {}),
    ...(typeof data.expiresIn === 'number' ? { expiresIn: data.expiresIn } : {}),
    ...(typeof data.profileArn === 'string' && data.profileArn ? { profileArn: data.profileArn } : {}),
  };
}

/** Renews the session. Kiro's refresh grant uses the same token endpoint. */
export async function refreshKiroCredential(credential: ProviderCredential): Promise<ProviderCredential> {
  if (credential.type !== 'oauth' || !credential.refreshToken) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'This Kiro session cannot be renewed. Sign in again.', {
      providerId: kiroProviderId,
      publicMessage: 'This Kiro session cannot be renewed. Sign in again.',
    });
  }
  const { data } = await postAuthJson<Json>(`${KIRO.oidc}/token`, {
    grantType: 'refresh_token',
    refreshToken: credential.refreshToken,
    clientId: credential.accountId ?? KIRO.clientName,
    clientSecret: KIRO.clientName,
  });
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!accessToken) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'AWS did not renew the Kiro session. Sign in again.', {
      providerId: kiroProviderId,
      publicMessage: 'AWS did not renew the Kiro session. Sign in again.',
    });
  }
  const expiresIn = typeof data.expiresIn === 'number' ? data.expiresIn : undefined;
  return {
    type: 'oauth',
    value: accessToken,
    ...(typeof data.refreshToken === 'string' ? { refreshToken: data.refreshToken } : { refreshToken: credential.refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
  };
}

/** True when the access token is within a minute of expiry. */
export function kiroCredentialExpired(credential: ProviderCredential | undefined, now = Date.now()): boolean {
  if (credential?.type !== 'oauth' || !credential.expiresAt) return false;
  const expiry = Date.parse(credential.expiresAt);
  return Number.isFinite(expiry) && expiry - 60_000 <= now;
}

/* ------------------------------------------------------------------ *
 * Inference
 * ------------------------------------------------------------------ */

/**
 * Message content is either a string or a list of parts, and Kiro's envelope takes plain
 * text, so both are flattened to text rather than one being dropped.
 */
function messageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

/**
 * Builds the `conversationState` envelope.
 *
 * Kiro takes the whole turn history rather than a message list, the model id is
 * addressed on the current message, and a system turn is folded into the user content
 * rather than sent as its own role, because the envelope has no system role.
 */
export function toKiroBody(request: ChatRequest, conversationId: string): Json {
  const system = request.messages.filter((message) => message.role === 'system').map((message) => messageText(message.content)).filter(Boolean);
  const turns = request.messages.filter((message) => message.role !== 'system');
  const current = turns[turns.length - 1];
  const history = turns.slice(0, -1).map((message) => ({
    [message.role === 'assistant' ? 'assistantResponseMessage' : 'userInputMessage']: {
      content: messageText(message.content),
      ...(message.role === 'assistant' ? { modelId: request.model } : { modelId: request.model, origin: 'AI_EDITOR' }),
    },
  }));
  const content = [system.length ? system.join('\n\n') : '', messageText(current?.content ?? '')].filter(Boolean).join('\n\n');
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: {
        userInputMessage: {
          content,
          modelId: request.model,
          origin: 'AI_EDITOR',
        },
      },
      history,
    },
    ...(request.maxOutputTokens === undefined ? {} : { inferenceConfig: { maxTokens: request.maxOutputTokens } }),
  };
}

function kiroHeaders(credential: ProviderCredential): Record<string, string> {
  // `value` exists on every variant except `none`, which never reaches a request.
  const token = credential.type === 'none' ? '' : credential.value;
  return {
    'content-type': 'application/json',
    accept: KIRO.eventStreamAccept,
    'X-Amz-Target': KIRO.streamingTarget,
    'User-Agent': KIRO.userAgent,
    'X-Amz-User-Agent': KIRO.amzUserAgent,
    Authorization: `Bearer ${token}`,
  };
}

/**
 * One decoded event from the stream.
 *
 * Kiro's eventstream arrives as `:event-type:` metadata lines and `data:` payloads, and
 * the payload nests the useful body under a key named after the event. A bare `data:`
 * with no event type is kept as text so a plain body is not silently dropped.
 */
export type KiroEvent = {
  type: string;
  text?: string;
  reasoning?: string;
  stopReason?: FinishReason;
  usage?: TokenUsage;
};

/** Event names Kiro nests its payload under, longest first so `x` never shadows `xY`. */
const kiroEventKeys = [
  'assistantResponseEvent',
  'reasoningContentEvent',
  'messageStopEvent',
  'usageEvent',
  'toolUseEvent',
  'codeEvent',
  'supplementaryWebLinksEvent',
] as const;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Json, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Decodes one eventstream frame. Exported so the framing can be tested on its own. */
export function decodeKiroEvent(payload: string, eventType: string): KiroEvent {
  let data: Json;
  try {
    const parsed: unknown = JSON.parse(payload);
    data = (typeof parsed === 'object' && parsed !== null ? parsed : { text: String(parsed) }) as Json;
  } catch {
    return eventType ? { type: eventType, text: payload } : { type: 'unknown', text: payload };
  }
  /**
   * The type comes from the framing when there is one, and otherwise from a key the
   * payload nests its body under. Inferring it matters: a response with no
   * `:event-type:` line at all would otherwise decode to an unknown event and read as an
   * empty answer rather than as a framing change.
   */
  const type =
    eventType ||
    readString(data, ['_eventType', 'event', 'eventType']) ||
    kiroEventKeys.find((key) => isRecord(data[key])) ||
    'unknown';

  if (type === 'assistantResponseEvent') {
    const nested = (data.assistantResponseEvent ?? data) as Json;
    const text = readString(nested, ['content', 'text']);
    return text === undefined ? { type } : { type, text };
  }
  if (type === 'reasoningContentEvent') {
    const nested = (data.reasoningContentEvent ?? data) as Json;
    const reasoning = readString(nested, ['content', 'text', 'reasoning']);
    return reasoning === undefined ? { type } : { type, reasoning };
  }
  if (type === 'messageStopEvent' || type === 'done') {
    const nested = (data.messageStopEvent ?? data) as Json;
    const reason = readString(nested, ['stopReason', 'stop_reason']);
    return { type, ...(reason ? { stopReason: kiroStopReason(reason) } : {}) };
  }
  if (type === 'usageEvent') {
    const nested = (data.usageEvent ?? data) as Json;
    const input = nested.inputTokens ?? nested.input_tokens;
    const output = nested.outputTokens ?? nested.output_tokens;
    const total = nested.totalTokens ?? nested.total_tokens;
    return {
      type,
      usage: {
        ...(typeof input === 'number' ? { inputTokens: input } : {}),
        ...(typeof output === 'number' ? { outputTokens: output } : {}),
        ...(typeof total === 'number' ? { totalTokens: total } : {}),
      },
    };
  }
  // `toolUseEvent` and the rest carry no text this adapter can use, and dropping them
  // silently would be indistinguishable from a truncated answer.
  return { type };
}

function kiroStopReason(reason: string): FinishReason {
  if (reason === 'max_tokens' || reason === 'MAX_TOKENS') return 'length';
  if (reason === 'tool_use' || reason === 'TOOL_USE') return 'tool_calls';
  return 'stop';
}

/**
 * Splits a raw eventstream body into events.
 *
 * The framing is line based: `:event-type: <name>` sets the type for the frames that
 * follow, and each `data:` line is one JSON payload. A `data:` line with no preceding
 * type still yields an event rather than being discarded.
 */
export function parseKiroEventStream(body: string): KiroEvent[] {
  const events: KiroEvent[] = [];
  let eventType = '';
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(':event-type:')) {
      eventType = line.slice(':event-type:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      const payload = line.slice('data:'.length).trim();
      if (payload) events.push(decodeKiroEvent(payload, eventType));
      continue;
    }
    if (!line.startsWith(':') && line.trim() && !eventType) {
      // Some responses are a bare JSON body with no framing at all.
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) events.push(decodeKiroEvent(trimmed, ''));
    }
  }
  return events;
}

/** The last event carrying a value of this kind, without needing ES2023's `findLast`. */
function lastOf<T>(events: readonly KiroEvent[], pick: (event: KiroEvent) => T | undefined): T | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined) continue;
    const value = pick(event);
    if (value !== undefined) return value;
  }
  return undefined;
}

function newConversationId(): string {
  return globalThis.crypto.randomUUID();
}

function conversationIdFor(request: ChatRequest): string {
  // Deterministic per request, so a retried request stays in one conversation.
  let hash = 0;
  for (const character of `${request.model}:${request.messages.map((m) => `${m.role}:${messageText(m.content)}`).join('|')}`) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return `omnihilbras-${(hash >>> 0).toString(16)}`;
}

export type KiroAdapterOptions = {
  transport?: HttpTransport;
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

export class KiroAdapter implements ProviderAdapter {
  readonly id = kiroProviderId;
  readonly name = 'Kiro';
  readonly capabilities = { chat: true, streaming: false, models: true } as const;

  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
  private renewed = new Map<string, ProviderCredential>();

  constructor(options: KiroAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchHttpTransport();
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Kiro publishes no model list over the API, so the catalog is the known set. That is
   * stated rather than implied: a model not in it is refused below instead of being sent
   * and coming back as `400 Invalid model`.
   */
  async listModels(): Promise<Model[]> {
    return KIRO_MODELS.map((model) => ({
      id: model.id,
      providerId: this.id,
      displayName: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    }));
  }

  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    if (credential?.type !== 'oauth' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Sign in to Kiro to use this provider.', {
        providerId: this.id,
        publicMessage: 'Sign in to Kiro to use this provider.',
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString() };
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const credential = await this.credential(context);
    const model = KIRO_MODELS.find((entry) => entry.id === request.model);
    if (!model) {
      throw new ProviderError('NOT_SUPPORTED', `Kiro does not offer a model called ${request.model}.`, {
        providerId: this.id,
        publicMessage: `Kiro does not offer a model called ${request.model}. Sign in to refresh the catalog.`,
      });
    }
    const response = await this.transport.request<string>({
      method: 'POST',
      providerId: this.id,
      url: KIRO.inferenceUrl,
      headers: kiroHeaders(credential),
      body: JSON.stringify(toKiroBody(request, conversationIdFor(request))),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
    const events = parseKiroEventStream(body);
    const text = events.map((event) => event.text ?? '').join('');
    const reasoning = events.map((event) => event.reasoning ?? '').join('');
    const stopReason = lastOf(events, (event) => event.stopReason) ?? 'stop';
    const usage = lastOf(events, (event) => event.usage);
    if (!text && !reasoning) {
      throw new ProviderError('INVALID_RESPONSE', 'Kiro returned no answer text.', {
        providerId: this.id,
        publicMessage: 'Kiro returned no answer text.',
      });
    }
    return {
      id: `kiro-${conversationIdFor(request)}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: text },
      finishReason: stopReason,
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * Kiro only speaks the eventstream, so a non-streaming answer is assembled from it and
   * yielded whole. Reporting that honestly beats implying a stream the provider does not
   * have.
   */
  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const response = await this.chat(request, context);
    yield {
      id: response.id,
      providerId: response.providerId,
      model: response.model,
      delta: { role: 'assistant', content: messageText(response.message.content) },
      finishReason: response.finishReason,
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; checkedAt: string; message?: string }> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The Kiro session could not be checked.',
      };
    }
  }

  /** Renews at expiry, memoised so one request never spends two refresh grants. */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential as ProviderCredential | undefined;
    if (!kiroCredentialExpired(current, this.now())) return current as ProviderCredential;
    // Only an OAuth credential can be expired, so the variant is known here.
    const stale = (current as Extract<ProviderCredential, { type: 'oauth' }>).value;
    const memo = this.renewed.get(stale);
    if (memo) return memo;
    const renewed = await refreshKiroCredential(current as ProviderCredential);
    this.renewed.set(stale, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }
}

export { newConversationId };
