import { ProviderError } from '../lib/errors.js';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CredentialValidation,
  FinishReason,
  Model,
  ProviderAdapter,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
} from '../lib/types.js';

/**
 * Grok Web, through the `sso` cookie a signed-in grok.com browser holds.
 *
 * Ported from the old project's `open-sse/executors/grok-web.js`. The endpoint is
 * not an API: it is the web app's conversation route, and it answers NDJSON rather
 * than OpenAI-shaped deltas.
 *
 * Two details are load-bearing and were measured upstream:
 *
 * - `modelMode` is not the model id. `grok-4.1-fast` sends the `grok-4-1-thinking`
 *   model with `MODEL_MODE_FAST`; sending only the model id answers the wrong mode
 *   or refuses the turn.
 * - The route is behind Cloudflare and checks the browser fingerprint. `x-statsig-id`,
 *   `x-xai-request-id` and `traceparent` are generated per request, and the headers
 *   below are the web client's own shape. They are not a claim that this is a browser.
 *
 * The credential is a whole subscription session. The card carries that warning.
 */

export const grokWebProviderId = 'grok-web';
export const GROK_WEB_ORIGIN = 'https://grok.com';
export const GROK_WEB_ENDPOINT = `${GROK_WEB_ORIGIN}/rest/app-chat/conversations/new`;
export const GROK_WEB_COOKIE = 'sso';

const DEFAULT_MODEL = 'grok-4.1-fast';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

type ModelMode = {
  grokModel: string;
  modelMode: string;
  thinking: boolean;
};

const MODEL_MAP: Record<string, ModelMode> = {
  'grok-3': { grokModel: 'grok-3', modelMode: 'MODEL_MODE_GROK_3', thinking: false },
  'grok-3-mini': { grokModel: 'grok-3', modelMode: 'MODEL_MODE_GROK_3_MINI_THINKING', thinking: true },
  'grok-3-thinking': { grokModel: 'grok-3', modelMode: 'MODEL_MODE_GROK_3_THINKING', thinking: true },
  'grok-4': { grokModel: 'grok-4', modelMode: 'MODEL_MODE_GROK_4', thinking: false },
  'grok-4-mini': { grokModel: 'grok-4-mini', modelMode: 'MODEL_MODE_GROK_4_MINI_THINKING', thinking: true },
  'grok-4-thinking': { grokModel: 'grok-4', modelMode: 'MODEL_MODE_GROK_4_THINKING', thinking: true },
  'grok-4-heavy': { grokModel: 'grok-4', modelMode: 'MODEL_MODE_HEAVY', thinking: true },
  'grok-4.1-mini': { grokModel: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_GROK_4_1_MINI_THINKING', thinking: true },
  'grok-4.1-fast': { grokModel: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_FAST', thinking: false },
  'grok-4.1-expert': { grokModel: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_EXPERT', thinking: true },
  'grok-4.1-thinking': { grokModel: 'grok-4-1-thinking-1129', modelMode: 'MODEL_MODE_GROK_4_1_THINKING', thinking: true },
  'grok-4.2': { grokModel: 'grok-420', modelMode: 'MODEL_MODE_GROK_420', thinking: false },
};

export const GROK_WEB_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'grok-3', name: 'Grok 3' },
  { id: 'grok-3-mini', name: 'Grok 3 Mini (Thinking)' },
  { id: 'grok-3-thinking', name: 'Grok 3 Thinking' },
  { id: 'grok-4', name: 'Grok 4' },
  { id: 'grok-4-mini', name: 'Grok 4 Mini (Thinking)' },
  { id: 'grok-4-thinking', name: 'Grok 4 Thinking' },
  { id: 'grok-4-heavy', name: 'Grok 4 Heavy (SuperGrok)' },
  { id: 'grok-4.1-mini', name: 'Grok 4.1 Mini (Thinking)' },
  { id: 'grok-4.1-fast', name: 'Grok 4.1 Fast' },
  { id: 'grok-4.1-expert', name: 'Grok 4.1 Expert' },
  { id: 'grok-4.1-thinking', name: 'Grok 4.1 Thinking' },
  { id: 'grok-4.2', name: 'Grok 4.2 (4.20 Beta)' },
];

/** A raw `sso` value, `sso=...`, or a whole Cookie header. */
export function normalizeGrokCookie(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/^cookie:\s*/i, '').trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the Grok sso cookie.', {
      providerId: grokWebProviderId,
      publicMessage: 'Paste the value of `sso` from grok.com, or the whole Cookie header.',
    });
  }
  return trimmed.includes('sso=') ? trimmed : `${GROK_WEB_COOKIE}=${trimmed}`;
}

export function grokWebCredential(raw: string): ProviderCredential {
  return { type: 'api-key', value: normalizeGrokCookie(raw) };
}

function cookieFromCredential(credential: ProviderCredential | undefined): string {
  if (credential?.type !== 'api-key' || !credential.value.trim()) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'No Grok session cookie was supplied.', {
      providerId: grokWebProviderId,
      publicMessage: 'Connect Grok Web with an sso cookie first.',
    });
  }
  return normalizeGrokCookie(credential.value);
}

function flattenContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ? String(content) : '';
  return content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ');
}

/** The old executor's prompt shape: earlier turns are role-labelled, the last user turn is not. */
export function buildGrokPrompt(messages: readonly ChatMessage[]): string {
  const extracted: Array<{ role: string; text: string }> = [];
  for (const message of messages) {
    let role = message.role;
    if (role === 'tool') role = 'user';
    const text = flattenContent(message.content);
    if (!text.trim()) continue;
    extracted.push({ role, text });
  }
  let lastUser = -1;
  for (let index = extracted.length - 1; index >= 0; index -= 1) {
    if (extracted[index]?.role === 'user') {
      lastUser = index;
      break;
    }
  }
  return extracted.map((item, index) => (index === lastUser ? item.text : `${item.role}: ${item.text}`)).join('\n\n');
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

function randomStatsigId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const message = Math.random() < 0.5
    ? `e:TypeError: Cannot read properties of null (reading 'children["${suffix}"]')`
    : `e:TypeError: Cannot read properties of undefined (reading '${suffix}')`;
  return btoa(message);
}

function refusal(status: number, what: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('AUTHENTICATION_FAILED', `Grok refused the session while ${what} (${status}).`, {
      providerId: grokWebProviderId,
      statusCode: status,
      publicMessage: 'Grok did not accept this session. Sign in at grok.com and paste a fresh sso cookie.',
    });
  }
  if (status === 429) {
    return new ProviderError('RATE_LIMITED', `Grok is rate limiting this session while ${what} (${status}).`, {
      providerId: grokWebProviderId,
      statusCode: status,
      retryable: true,
      publicMessage: 'Grok is rate limiting requests. Wait a moment and try again.',
    });
  }
  if (status >= 500) {
    return new ProviderError('PROVIDER_UNAVAILABLE', `Grok answered ${status} while ${what}.`, {
      providerId: grokWebProviderId,
      statusCode: status,
      retryable: true,
    });
  }
  return new ProviderError('PROVIDER_REQUEST_FAILED', `Grok answered ${status} while ${what}.`, {
    providerId: grokWebProviderId,
    statusCode: status,
    publicMessage: `Grok refused the request (${status}).`,
  });
}

function normalizeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ProviderError('CANCELLED', 'The Grok request was cancelled.', { providerId: grokWebProviderId });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError('PROVIDER_REQUEST_FAILED', `Grok Web could not be reached: ${message}`, {
    providerId: grokWebProviderId,
    publicMessage: 'Grok Web could not be reached. Check the network and the sso cookie.',
    cause: error,
  });
}

export function buildGrokBody(model: string, prompt: string) {
  const selected = MODEL_MAP[model] ?? MODEL_MAP[DEFAULT_MODEL]!;
  return {
    temporary: true,
    modelName: selected.grokModel,
    modelMode: selected.modelMode,
    message: prompt,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: false,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: false,
    imageGenerationCount: 0,
    forceConcise: false,
    toolOverrides: {},
    enableSideBySide: true,
    sendFinalMetadata: true,
    isReasoning: false,
    disableTextFollowUps: false,
    disableMemory: true,
    forceSideBySide: false,
    isAsyncChat: false,
    disableSelfHarmShortCircuit: false,
    deviceEnvInfo: {
      darkModeEnabled: false,
      devicePixelRatio: 2,
      screenWidth: 2056,
      screenHeight: 1329,
      viewportWidth: 2056,
      viewportHeight: 1083,
    },
  };
}

type GrokEvent = {
  error?: { message?: string; code?: string };
  result?: {
    response?: {
      llmInfo?: { modelHash?: string };
      responseId?: string;
      response?: unknown;
      modelResponse?: { message?: string; metadata?: { llm_info?: { modelHash?: string } } };
      token?: string;
    };
  };
};

async function* readGrokNdjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<GrokEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) {
          try {
            yield JSON.parse(line) as GrokEvent;
          } catch {
            // A keep-alive or a truncated frame is not a record.
          }
        }
        at = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as GrokEvent;
      } catch {
        // The final partial frame is not a record.
      }
    }
  } finally {
    reader.releaseLock();
  }
}

type Extracted =
  | { kind: 'delta'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'full'; text: string; fingerprint?: string }
  | { kind: 'done'; answer: string; fingerprint?: string }
  | { kind: 'error'; message: string };

export async function* extractGrokContent(body: ReadableStream<Uint8Array>, thinkingModel: boolean, signal?: AbortSignal): AsyncGenerator<Extracted> {
  let answer = '';
  let fingerprint = '';
  let thinkOpened = false;
  for await (const event of readGrokNdjson(body, signal)) {
    if (event.error) {
      yield { kind: 'error', message: event.error.message ?? `Grok error: ${event.error.code ?? 'unknown'}` };
      return;
    }
    const response = event.result?.response;
    if (!response) continue;
    if (response.llmInfo?.modelHash && !fingerprint) fingerprint = response.llmInfo.modelHash;
    if (response.modelResponse) {
      if (thinkOpened && thinkingModel) {
        if (response.modelResponse.message) yield { kind: 'thinking', text: response.modelResponse.message };
        thinkOpened = false;
      }
      if (response.modelResponse.message) {
        answer = response.modelResponse.message;
        yield { kind: 'full', text: answer, ...(fingerprint ? { fingerprint } : {}) };
      }
      if (response.modelResponse.metadata?.llm_info?.modelHash) fingerprint = response.modelResponse.metadata.llm_info.modelHash;
      continue;
    }
    if (typeof response.token === 'string') {
      answer += response.token;
      yield { kind: 'delta', text: response.token };
    }
  }
  yield { kind: 'done', answer, ...(fingerprint ? { fingerprint } : {}) };
}

export class GrokWebAdapter implements ProviderAdapter {
  readonly id = grokWebProviderId;
  readonly name = 'Grok Web';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(): Promise<Model[]> {
    return GROK_WEB_MODELS.map((model) => ({ id: model.id, providerId: this.id, displayName: model.name }));
  }

  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const cookie = cookieFromCredential(credential);
    const response = await this.request(buildGrokBody('grok-4', 'ping'), cookie, context.signal);
    if (response.status === 401 || response.status === 403) throw refusal(response.status, 'checking the session');
    if (response.status === 429) throw refusal(response.status, 'checking the session');
    if (response.status >= 500) throw refusal(response.status, 'checking the session');
    return { status: 'valid', checkedAt: new Date(this.now()).toISOString() };
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.validateCredential(context.credential, context);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date(this.now()).toISOString(),
        message: error instanceof Error ? error.message : 'The Grok session could not be checked.',
      };
    }
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const cookie = cookieFromCredential(context.credential);
    const prompt = buildGrokPrompt(request.messages);
    if (!prompt.trim()) throw new ProviderError('INVALID_REQUEST', 'Grok Web needs a user message.', { providerId: this.id });
    const selected = MODEL_MAP[request.model] ?? MODEL_MAP[DEFAULT_MODEL]!;
    const response = await this.request(buildGrokBody(request.model, prompt), cookie, context.signal);
    if (!response.ok) throw refusal(response.status, 'answering the completion');
    if (!response.body) throw new ProviderError('INVALID_RESPONSE', 'Grok returned no response body.', { providerId: this.id });

    let answer = '';
    let reasoning = '';
    for await (const chunk of extractGrokContent(response.body, selected.thinking, context.signal)) {
      if (chunk.kind === 'error') throw new ProviderError('PROVIDER_REQUEST_FAILED', `Grok refused the turn: ${chunk.message}`, { providerId: this.id });
      if (chunk.kind === 'thinking') reasoning += `${chunk.text}\n`;
      if (chunk.kind === 'full') answer = chunk.text;
      if (chunk.kind === 'delta') answer += chunk.text;
      if (chunk.kind === 'done') answer = chunk.answer || answer;
    }
    if (!answer.trim()) throw new ProviderError('INVALID_RESPONSE', 'Grok answered, but the stream carried no answer text.', { providerId: this.id });
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(answer.length / 4);
    return {
      id: `chatcmpl-grok-${Math.floor(this.now() / 1000)}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date(this.now()).toISOString(),
      message: { role: 'assistant', content: answer, ...(reasoning.trim() ? { reasoning: reasoning.trim() } : {}) },
      finishReason: 'stop' satisfies FinishReason,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true },
    };
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const cookie = cookieFromCredential(context.credential);
    const prompt = buildGrokPrompt(request.messages);
    if (!prompt.trim()) throw new ProviderError('INVALID_REQUEST', 'Grok Web needs a user message.', { providerId: this.id });
    const selected = MODEL_MAP[request.model] ?? MODEL_MAP[DEFAULT_MODEL]!;
    const response = await this.request(buildGrokBody(request.model, prompt), cookie, context.signal);
    if (!response.ok) throw refusal(response.status, 'answering the completion');
    if (!response.body) throw new ProviderError('INVALID_RESPONSE', 'Grok returned no response body.', { providerId: this.id });

    const id = `chatcmpl-grok-${Math.floor(this.now() / 1000)}`;
    let started = false;
    let answer = '';
    let finalAnswer = '';
    for await (const chunk of extractGrokContent(response.body, selected.thinking, context.signal)) {
      if (chunk.kind === 'error') throw new ProviderError('PROVIDER_REQUEST_FAILED', `Grok refused the turn: ${chunk.message}`, { providerId: this.id });
      if (chunk.kind === 'thinking') continue;
      if (chunk.kind === 'full') {
        // A final modelResponse can be the only content frame; yield it once if no
        // token delta arrived first, and do not duplicate it after deltas.
        if (!started) {
          answer = chunk.text;
          started = true;
          yield { id, providerId: this.id, model: request.model, delta: { role: 'assistant', content: chunk.text } };
        }
        continue;
      }
      if (chunk.kind === 'done') {
        finalAnswer = chunk.answer;
        break;
      }
      if (chunk.kind === 'delta') {
        answer += chunk.text;
        if (!started) {
          started = true;
          yield { id, providerId: this.id, model: request.model, delta: { role: 'assistant', content: chunk.text } };
        } else {
          yield { id, providerId: this.id, model: request.model, delta: { content: chunk.text } };
        }
      }
    }
    if (!started && finalAnswer) {
      yield { id, providerId: this.id, model: request.model, delta: { role: 'assistant', content: finalAnswer } };
    }
    yield { id, providerId: this.id, model: request.model, delta: {}, finishReason: 'stop' };
  }

  private async request(body: unknown, cookie: string, signal?: AbortSignal): Promise<Response> {
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    try {
      return await this.fetchImpl(GROK_WEB_ENDPOINT, {
        method: 'POST',
        headers: {
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          origin: GROK_WEB_ORIGIN,
          pragma: 'no-cache',
          referer: `${GROK_WEB_ORIGIN}/`,
          'sec-ch-ua': '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': USER_AGENT,
          'x-statsig-id': randomStatsigId(),
          'x-xai-request-id': crypto.randomUUID(),
          traceparent: `00-${traceId}-${spanId}-00`,
          Cookie: cookie,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw normalizeError(error);
    }
  }
}
