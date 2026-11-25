import { ProviderError } from '@omnihilbras/sdk-shared/errors';
import { normalizeCatalogModel } from '@omnihilbras/sdk-shared/model-normalize';
import { readResponsesFrame, responsesLaneFor, responsesLaneRefusal, rememberResponsesLane, toResponsesBody, toResponsesChatResponse, type ResponsesPayload, type ResponsesStreamEvent } from './responses-lane.js';
import { parseSseJson, parseSseStream } from '@omnihilbras/sdk-shared/streaming';
import { FetchHttpTransport, type HttpTransport } from './transport.js';
import { assertSafeProviderHeaderName, assertSafeProviderHeaderValue, normalizeProviderBaseUrl, resolveProviderUrl, sanitizeProviderHeaders } from '@omnihilbras/sdk-shared/url';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, FinishReason, ImageRequest, ImageResponse, AudioSpeechRequest, AudioSpeechResponse, AudioTranscriptionRequest, AudioTranscriptionResponse, MessageContent, Model, ProviderAdapter, ProviderCapabilities, ProviderCredential, ProviderHealth, ProviderRequestContext, TokenUsage, ToolCall, ToolDefinition } from './types.js';

export type OpenAICompatibleAuth = {
  header?: string;
  prefix?: string;
  required?: boolean;
};

export type OpenAICompatibleAdapterConfig = {
  id: string;
  name: string;
  baseUrl: string;
  auth?: OpenAICompatibleAuth;
  modelsPath?: string;
  chatPath?: string;
  /**
   * The OpenAI **Responses** lane for this endpoint, or absent when the endpoint has none.
   *
   * **Setting it is the opt-in, and the path is the value** — there is no default path, because a default
   * would mean an endpoint could acquire a lane by a typo, pointed at a path nobody measured on it. A
   * provider that does not set it has no Responses lane and behaves exactly as it did, including when a
   * model refuses the chat path — which is the difference between "this endpoint has a second lane" and
   * "this gateway retries things".
   *
   * The lane is chosen **per model**, from the provider's own refusal, and remembered for the process; the
   * measurement, the wording it matches and why it is learned rather than matched by model name are in
   * `lib/responses-lane.ts`.
   */
  responsesPath?: string;
  /**
   * Where the embeddings endpoint lives, relative to `baseUrl`.
   *
   * Beside `modelsPath`/`chatPath` and defaulted the same way, rather than derived from `chatPath`. A
   * provider that serves `/v1/chat/completions` and `/v1/embeddings` has no rule connecting the two —
   * deriving one would be a guess about a third party's URL layout, and the failure mode of a wrong
   * guess is a 404 that reads as "this provider has no embeddings" when it does.
   */
  embeddingsPath?: string;
  headers?: Record<string, string>;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  capabilities?: ProviderCapabilities;
  /** The model family this endpoint serves, so a bare name of that family is routed here. */
  modelFamily?: string;
  /**
   * Rewrites a non-streaming response body before it is read as an OpenAI
   * response, for a provider that wraps one. Scoped to non-streaming on purpose:
   * a provider whose streaming format differs needs its own adapter, not a hook
   * that silently reshapes a live event stream.
   *
   * May throw to turn a wrapped error envelope into a `ProviderError`.
   */
  unwrapResponse?: (body: unknown) => OpenAIResponse;
};

export type OpenAICompatibleAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
  /**
   * Headers that depend on the request, not on the provider's configuration.
   *
   * A static `config.headers` map cannot carry a conversation id, and a constant value would present
   * every conversation as one. OpenCode Go is the provider that needs this today.
   */
  requestHeaders?: (request: ChatRequest) => Record<string, string>;
};

type OpenAIChoice = {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
};

export type OpenAIResponse = {
  id?: string;
  model?: string;
  created?: number;
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

type OpenAIStreamChunk = OpenAIResponse & {
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

/**
 * OpenAI's `/v1/embeddings` response.
 *
 * `dimensions` is deliberately **not** a field here. OpenAI does not send one — the dimension count is
 * `data[i].embedding.length`, which is the only measured answer — so a field for it would be a number
 * this SDK invented. `EmbeddingVector.dimensions` is filled from the array's own length, which is a
 * measurement and therefore cannot disagree with the vector.
 */
type OpenAIEmbeddingResponse = {
  id?: string;
  model?: string;
  created?: number;
  data?: Array<{ object?: string; index?: number; embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

type OpenAIModelList = {
  data?: Array<OpenAIModelEntry>;
  models?: Array<OpenAIModelEntry>;
  results?: Array<OpenAIModelEntry>;
  items?: Array<OpenAIModelEntry>;
};
type OpenAIModelEntry = {
  id?: string;
  owned_by?: string;
  name?: string;
  display_name?: string;
  context_length?: number;
  context_window?: number;
  max_context_length?: number;
  max_context_window?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
  pricing?: {
    inputPer1M?: number;
    outputPer1M?: number;
    cacheReadPer1M?: number;
    cacheWritePer1M?: number;
    prompt?: number | string;
    completion?: number | string;
    input_cache_read?: number | string;
  };
};

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly modelFamily?: string;
  private readonly baseUrl: string;
  private readonly auth: Required<Pick<OpenAICompatibleAuth, 'required'>> & OpenAICompatibleAuth;
  private readonly modelsPath: string;
  private readonly chatPath: string;
  private readonly responsesPath?: string;
  private readonly embeddingsPath: string;
  private readonly unwrap?: OpenAICompatibleAdapterConfig['unwrapResponse'];
  private readonly headers: Record<string, string>;
  private readonly dynamicHeaders?: (request: ChatRequest) => Record<string, string>;
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
  protected readonly transport: HttpTransport;

  constructor(config: OpenAICompatibleAdapterConfig, options: OpenAICompatibleAdapterOptions = {}) {
    this.id = config.id;
    this.name = config.name;
    this.baseUrl = normalizeProviderBaseUrl(config.baseUrl, config.id);
    const authHeader = config.auth?.header ?? (config.auth?.required === false ? undefined : 'Authorization');
    const authPrefix = config.auth?.prefix ?? (config.auth?.header ? undefined : 'Bearer');
    if (authHeader) assertSafeProviderHeaderName(authHeader, config.id, { allowCredential: true });
    if (authPrefix && /[\r\n\0]/.test(authPrefix)) throw new ProviderError('CONFIGURATION_ERROR', `Authentication prefix is unsafe for provider ${config.id}.`, { providerId: config.id });
    this.auth = {
      header: authHeader,
      prefix: authPrefix,
      required: config.auth?.required ?? true,
    };
    this.modelsPath = config.modelsPath ?? '/models';
    this.chatPath = config.chatPath ?? '/chat/completions';
    if (config.responsesPath !== undefined) this.responsesPath = config.responsesPath;
    this.embeddingsPath = config.embeddingsPath ?? '/embeddings';
    this.unwrap = config.unwrapResponse;
    this.headers = sanitizeProviderHeaders(config.headers, config.id);
    this.maxTokensField = config.maxTokensField ?? 'max_tokens';
    if (config.modelFamily !== undefined) this.modelFamily = config.modelFamily;
    this.capabilities = {
      chat: true,
      streaming: true,
      models: true,
      /**
       * **Not defaulted to true, and that is a deliberate gap rather than an omission.**
       *
       * An OpenAI-shaped base URL is not evidence that `/embeddings` exists on it: plenty of
       * compatible servers implement chat and nothing else. Defaulting this on would make `embed()`
       * appear to work against a provider that has no such endpoint, and the failure would be a 404
       * from a third party rather than a truthful `NOT_SUPPORTED` naming our own adapter.
       *
       * So a deployment opts in by setting `capabilities: { embeddings: true }` — a statement that
       * someone verified the endpoint exists. `createGatewayService` does that for the built-in
       * providers whose embeddings endpoints are documented, and not for the open-ended
       * `openai-compatible` one, which is why the first release of this ships embeddings for named
       * providers rather than for every custom endpoint.
       */
      embeddings: false,
      ...config.capabilities,
    };
    this.dynamicHeaders = options.requestHeaders;
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const response = await this.transport.request<OpenAIModelList | Array<OpenAIModelEntry>>({
      method: 'GET',
      providerId: this.id,
      url: this.url(this.modelsPath),
      headers: this.requestHeaders(context.credential, 'application/json'),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const data = response.data;
    const entries = Array.isArray(data) ? data : data?.data ?? data?.models ?? data?.results ?? data?.items;
    if (!Array.isArray(entries)) throw invalidResponse(this.id, `Provider model list is missing data (top-level keys: ${data && typeof data === 'object' ? Object.keys(data).join(', ') : 'none'}).`);
    return entries.flatMap((model) => (typeof model.id === 'string' && model.id ? [normalizeCatalogModel(model, this.id)] : []));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    // A model this process already proved is on the Responses lane goes straight there: the refusal was
    // the evidence, and paying for it a second time on every turn is the whole cost this memo exists to
    // avoid.
    if (this.responsesPath && responsesLaneFor(this.id, request.model)) {
      return this.chatResponses(request, context);
    }
    try {
      const response = await this.transport.request<OpenAIResponse>({
        method: 'POST',
        providerId: this.id,
        url: this.url(this.chatPath),
        headers: this.requestHeaders(context.credential, 'application/json', request),
        body: JSON.stringify(this.toRequestBody(request, false)),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return this.toChatResponse(this.unwrap ? this.unwrap(response.data) : response.data, request.model);
    } catch (error) {
      if (!this.rememberLaneOnRefusal(error, request.model)) throw error;
      return this.chatResponses(request, context, error);
    }
  }

  /**
   * Whether this refusal is the provider telling us where the model actually lives.
   *
   * The memo is written **before** the retry rather than after it. The refusal is the evidence, not the
   * retry's success: a model the relay will not serve on the chat path is on the Responses lane whatever
   * happens next, and a second turn should not rediscover that. Every other error returns false and is
   * rethrown untouched by the caller — the decision is the provider's own sentence, so a 401, a 403, a 408, a
   * 429, an outage whose text names neither endpoint, and a 400 about the request body all keep exactly the
   * behaviour they had. This is a lane switch, not a retry policy.
   */
  private rememberLaneOnRefusal(error: unknown, model: string): boolean {
    if (!this.responsesPath) return false;
    if (!responsesLaneRefusal(error)) return false;
    rememberResponsesLane(this.id, model);
    return true;
  }

  /**
   * One turn on the Responses lane.
   *
   * `cause` is the chat lane's refusal, when this request started there. If this attempt fails too, the
   * error a caller sees is **this** one — it is the failure that ended the turn, and its status is what a
   * retry policy reads — with the earlier refusal attached as its cause, so the chain still carries what
   * the provider said the first time. Replacing a specific refusal with a vaguer one is how two different
   * defects start to read alike.
   *
   * `unwrapResponse` is deliberately not applied: it exists to reshape a `choices`-shaped body a provider
   * wrapped, and a Responses payload has no `choices` for it to find.
   */
  private async chatResponses(request: ChatRequest, context: ProviderRequestContext, cause?: unknown): Promise<ChatResponse> {
    try {
      const response = await this.transport.request<ResponsesPayload>({
        method: 'POST',
        providerId: this.id,
        url: this.url(this.responsesPath as string),
        headers: this.requestHeaders(context.credential, 'application/json', request),
        body: JSON.stringify(toResponsesBody(request, false)),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return toResponsesChatResponse(response.data, request.model, this.id);
    } catch (error) {
      throw withCause(error, cause);
    }
  }

  /**
   * `/embeddings`, in the shape OpenAI's own endpoint uses.
   *
   * Present only because `embeddingsPath` was configured or because the caller declared the
   * capability — see the constructor. An adapter that advertises `embeddings: false` throws
   * `NOT_SUPPORTED` rather than making a request that is guaranteed to fail, so a caller learns the
   * provider cannot serve this without spending a round trip finding out.
   */
  async embed(request: EmbeddingRequest, context: ProviderRequestContext = {}): Promise<EmbeddingResponse> {
    if (!this.capabilities.embeddings) {
      throw new ProviderError('NOT_SUPPORTED', `${this.name} does not support embeddings.`, {
        providerId: this.id,
        publicMessage: `${this.name} does not support embeddings.`,
      });
    }
    const inputs = typeof request.input === 'string' ? [request.input] : [...request.input];
    if (inputs.length === 0 || inputs.some((value) => !value)) {
      throw new ProviderError('INVALID_REQUEST', 'Embedding input must be a non-empty string or a non-empty array of non-empty strings.', { providerId: this.id });
    }
    const body: Record<string, unknown> = { model: request.model, input: inputs };
    if (request.dimensions !== undefined) body.dimensions = request.dimensions;
    if (request.encodingFormat !== undefined) body.encoding_format = request.encodingFormat;
    if (request.user !== undefined) body.user = request.user;

    const response = await this.transport.request<OpenAIEmbeddingResponse>({
      method: 'POST',
      providerId: this.id,
      url: this.url(this.embeddingsPath),
      headers: this.requestHeaders(context.credential, 'application/json'),
      body: JSON.stringify(body),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const payload = response.data;
    const rows = payload?.data;
    if (!Array.isArray(rows)) throw invalidResponse(this.id, 'Provider embeddings response is missing data.');

    const vectors = rows.map((row, position) => {
      const embedding = row?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw invalidResponse(this.id, `Provider embedding at index ${position} is missing its vector.`);
      }
      if (embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw invalidResponse(this.id, `Provider embedding at index ${position} contains a non-numeric value.`);
      }
      return {
        index: typeof row?.index === 'number' ? row.index : position,
        embedding,
        // **Measured from the vector itself**, never assumed. See `EmbeddingVector.dimensions`.
        dimensions: embedding.length,
      };
    });

    // The provider returns one row per input. A short list means the caller asked for N vectors and got
    // fewer, which is a wrong answer, not a partial success — and silently returning it would hand back
    // an array whose positions no longer line up with the inputs the caller sent.
    if (vectors.length !== inputs.length) {
      throw invalidResponse(this.id, `Provider returned ${vectors.length} embedding(s) for ${inputs.length} input(s).`);
    }

    return {
      id: payload.id ?? `embed-${request.model}`,
      providerId: this.id,
      model: payload.model ?? request.model,
      createdAt: new Date((typeof payload.created === 'number' ? payload.created : Date.now() / 1000) * 1000).toISOString(),
      data: vectors,
      ...(payload.usage ? { usage: normalizeUsage(payload.usage) } : {}),
    };
  }

  async image(request: ImageRequest, context: ProviderRequestContext = {}): Promise<ImageResponse> {
    if (!this.capabilities.images) {
      throw new ProviderError('NOT_SUPPORTED', `${this.name} does not support images.`, {
        providerId: this.id,
        publicMessage: `${this.name} does not support images.`,
      });
    }
    const body: Record<string, unknown> = { model: request.model, prompt: request.prompt };
    if (request.n !== undefined) body.n = request.n;
    if (request.size !== undefined) body.size = request.size;
    if (request.quality !== undefined) body.quality = request.quality;
    if (request.responseFormat !== undefined) body.response_format = request.responseFormat;
    if (request.user !== undefined) body.user = request.user;

    const response = await this.transport.request<{ created?: number; data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> }>({
      method: 'POST',
      providerId: this.id,
      url: this.url('/images/generations'),
      headers: this.requestHeaders(context.credential, 'application/json'),
      body: JSON.stringify(body),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const rows = response.data?.data;
    if (!Array.isArray(rows)) throw invalidResponse(this.id, 'Provider image response is missing data.');

    const data = rows.map((row) => ({
      ...(row.url !== undefined ? { url: row.url } : {}),
      ...(row.b64_json !== undefined ? { b64Json: row.b64_json } : {}),
      ...(row.revised_prompt !== undefined ? { revisedPrompt: row.revised_prompt } : {}),
    }));

    return {
      id: `image-${request.model}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date((typeof response.data?.created === 'number' ? response.data.created : Date.now() / 1000) * 1000).toISOString(),
      data,
    };
  }

  async audio(request: AudioSpeechRequest, context: ProviderRequestContext = {}): Promise<AudioSpeechResponse> {
    if (!this.capabilities.audio) {
      throw new ProviderError('NOT_SUPPORTED', `${this.name} does not support audio.`, {
        providerId: this.id,
        publicMessage: `${this.name} does not support audio.`,
      });
    }
    const body: Record<string, unknown> = { model: request.model, input: request.input };
    if (request.voice !== undefined) body.voice = request.voice;
    if (request.responseFormat !== undefined) body.response_format = request.responseFormat;
    if (request.speed !== undefined) body.speed = request.speed;
    if (request.user !== undefined) body.user = request.user;

    const response = await this.transport.request<Uint8Array>({
      method: 'POST',
      providerId: this.id,
      url: this.url('/audio/speech'),
      headers: this.requestHeaders(context.credential, 'application/json'),
      body: JSON.stringify(body),
      responseAs: 'bytes',
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const audio = response.data;
    const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
    return {
      id: `audio-${request.model}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      audio,
      contentType,
    };
  }

  async transcribe(request: AudioTranscriptionRequest, context: ProviderRequestContext = {}): Promise<AudioTranscriptionResponse> {
    if (!this.capabilities.audio) {
      throw new ProviderError('NOT_SUPPORTED', `${this.name} does not support audio.`, {
        providerId: this.id,
        publicMessage: `${this.name} does not support audio.`,
      });
    }
    const audioBytes = Buffer.from(request.audio, 'base64');
    const boundary = `----omnihilbras${Date.now().toString(16)}`;
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const pushStr = (str: string) => parts.push(enc.encode(str));
    pushStr(`--${boundary}\r\n`);
    pushStr(`Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n`);
    pushStr(`Content-Type: audio/wav\r\n\r\n`);
    parts.push(new Uint8Array(audioBytes));
    pushStr(`\r\n--${boundary}\r\n`);
    pushStr(`Content-Disposition: form-data; name="model"\r\n\r\n`);
    pushStr(`${request.model}\r\n`);
    if (request.language) {
      pushStr(`--${boundary}\r\n`);
      pushStr(`Content-Disposition: form-data; name="language"\r\n\r\n`);
      pushStr(`${request.language}\r\n`);
    }
    if (request.prompt) {
      pushStr(`--${boundary}\r\n`);
      pushStr(`Content-Disposition: form-data; name="prompt"\r\n\r\n`);
      pushStr(`${request.prompt}\r\n`);
    }
    if (request.responseFormat) {
      pushStr(`--${boundary}\r\n`);
      pushStr(`Content-Disposition: form-data; name="response_format"\r\n\r\n`);
      pushStr(`${request.responseFormat}\r\n`);
    }
    if (request.temperature !== undefined) {
      pushStr(`--${boundary}\r\n`);
      pushStr(`Content-Disposition: form-data; name="temperature"\r\n\r\n`);
      pushStr(`${request.temperature}\r\n`);
    }
    pushStr(`--${boundary}--\r\n`);

    let total = 0;
    for (const p of parts) total += p.byteLength;
    const body = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { body.set(p, off); off += p.byteLength; }

    const response = await this.transport.request<{ text?: string; language?: string; duration?: number }>({
      method: 'POST',
      providerId: this.id,
      url: this.url('/audio/transcriptions'),
      headers: {
        ...this.requestHeaders(context.credential, ''),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const payload = response.data ?? {};
    if (typeof payload.text !== 'string') throw invalidResponse(this.id, 'Provider transcription response is missing text.');
    return {
      id: `transcription-${request.model}`,
      providerId: this.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      text: payload.text,
      ...(payload.language !== undefined ? { language: payload.language } : {}),
      ...(typeof payload.duration === 'number' ? { duration: payload.duration } : {}),
    };
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    if (this.responsesPath && responsesLaneFor(this.id, request.model)) {
      yield* this.streamResponses(request, context);
      return;
    }

    let yielded = false;
    try {
      for await (const chunk of this.chatLaneChunks(request, context)) {
        // Set before the yield, not after: once a chunk is in the caller's hands the answer has started,
        // and a second attempt from here would repeat what they already have or interleave two answers.
        yielded = true;
        yield chunk;
      }
    } catch (error) {
      // A refusal arrives **before** the first event — `transport.stream` reads the status and throws
      // without yielding — so an empty `yielded` is what makes this the same turn retried rather than a
      // half-answer duplicated.
      if (yielded || !this.rememberLaneOnRefusal(error, request.model)) throw error;
      yield* this.streamResponses(request, context, error);
    }
  }

  /**
   * The chat lane's stream: the request every provider has always received.
   *
   * Split out of `streamChat` so the lane decision wraps it without a second copy of the frame loop — two
   * copies of a stream reader is how one of them stops handling a finish reason.
   */
  private async *chatLaneChunks(request: ChatRequest, context: ProviderRequestContext): AsyncIterable<ChatChunk> {
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: this.url(this.chatPath),
      headers: this.requestHeaders(context.credential, 'text/event-stream', request),
      body: JSON.stringify(this.toRequestBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    let sawMeaningfulPayload = false;
    let sawDone = false;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      const payload = parseSseJson<OpenAIStreamChunk>(event, this.id);
      if (!payload) continue;
      sawPayload = true;
      if (payload.error) throw providerStreamError(this.id, payload.error);

      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      if (delta?.role || delta?.content || delta?.tool_calls?.length || choice?.finish_reason || payload.usage) sawMeaningfulPayload = true;
      const chunk: ChatChunk = {
        id: payload.id ?? `stream-${request.model}`,
        providerId: this.id,
        model: payload.model ?? request.model,
        delta: {
          ...(delta?.role ? { role: normalizeRole(delta.role) } : {}),
          ...(delta?.content ? { content: delta.content } : {}),
          ...(delta?.tool_calls?.length ? { toolCalls: delta.tool_calls.map(normalizeToolCallDelta) } : {}),
        },
        ...(choice?.finish_reason ? { finishReason: normalizeFinishReason(choice.finish_reason) } : {}),
        ...(payload.usage ? { usage: normalizeUsage(payload.usage) } : {}),
      };
      yield chunk;
    }

    if (!sawPayload || !sawMeaningfulPayload || !sawDone) {
      throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before completion.', { providerId: this.id });
    }
  }

  /**
   * The stream on the Responses lane, with the chat lane's refusal kept as the cause of a second failure.
   *
   * A wrapper rather than a `try` inside the reader, because a generator cannot attach a cause to an error
   * it has already thrown — and the cause is the whole point: the caller sees the failure that ended the
   * turn, and the reason the chat path was abandoned is still readable behind it.
   */
  private async *streamResponses(request: ChatRequest, context: ProviderRequestContext, cause?: unknown): AsyncIterable<ChatChunk> {
    try {
      yield* this.responsesLaneChunks(request, context);
    } catch (error) {
      throw withCause(error, cause);
    }
  }

  /**
   * The Responses event stream, as our chunks.
   *
   * The terminator is `response.completed` (or `response.incomplete` for a truncated turn), which is the
   * Responses protocol's own end-of-turn frame; the chat lane's `[DONE]` sentinel does not appear here. A
   * stream that ends without one is reported rather than returned as an answer, exactly as the chat lane
   * treats a stream that stopped mid-answer.
   */
  private async *responsesLaneChunks(request: ChatRequest, context: ProviderRequestContext): AsyncIterable<ChatChunk> {
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: this.url(this.responsesPath as string),
      headers: this.requestHeaders(context.credential, 'text/event-stream', request),
      body: JSON.stringify(toResponsesBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    let sawMeaningfulPayload = false;
    let sawTerminal = false;
    for await (const event of parseSseStream(events)) {
      const payload = parseSseJson<ResponsesStreamEvent>(event, this.id);
      if (!payload) continue;
      sawPayload = true;
      const frame = readResponsesFrame(payload);
      // The provider's own sentence, not a verdict: `response.failed` carries the reason, and dropping it
      // makes a refused turn read as a truncated stream.
      if (frame.failure) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', `The provider stream returned an error: ${frame.failure}`, { providerId: this.id });
      }
      if (frame.text || frame.toolCall || frame.finishReason || frame.usage) sawMeaningfulPayload = true;
      if (frame.terminal) sawTerminal = true;
      yield {
        id: payload.response?.id ?? `stream-${request.model}`,
        providerId: this.id,
        model: payload.response?.model ?? request.model,
        delta: {
          ...(frame.text ? { content: frame.text } : {}),
          ...(frame.toolCall ? { toolCalls: [frame.toolCall] } : {}),
        },
        ...(frame.finishReason ? { finishReason: frame.finishReason } : {}),
        ...(frame.usage ? { usage: frame.usage } : {}),
      };
      /**
       * The terminal frame ends the turn. Continuing to consume after it lets a keep-alive, a late
       * event, or a provider bug append another chunk after `completed`, which the gateway would
       * relay as a second terminal item.
       */
      if (frame.terminal) break;
    }

    if (!sawPayload || !sawMeaningfulPayload || !sawTerminal) {
      throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before completion.', { providerId: this.id });
    }
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      await this.listModels(context);
      return { status: 'healthy' as const, verified: 'credential', latencyMs: Math.round(performance.now() - startedAt), checkedAt: new Date().toISOString() };
    } catch (error) {
      /**
       * The reason, not just the verdict.
       *
       * A bare `catch {}` reported `unavailable` with nothing attached, so the dashboard could
       * only say "unavailable" — not whether the key was rejected, the endpoint was wrong, or the
       * provider was down. Those need three different things from the user, and "unavailable" is
       * none of them. Found by the provider contract on its first run.
       */
      return {
        status: 'unavailable' as const, verified: 'credential',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The health check failed without a reason.',
      };
    }
  }

  protected url(path: string) {
    return resolveProviderUrl(this.baseUrl, path, this.id);
  }

  protected requestHeaders(credential: ProviderCredential | undefined, accept: string, request?: ChatRequest) {
    const headers: Record<string, string> = {
      accept,
      ...this.headers,
      ...(request && this.dynamicHeaders ? this.dynamicHeaders(request) : {}),
      'content-type': 'application/json',
    };
    if (credential?.type === 'api-key' && this.auth.header) {
      assertSafeProviderHeaderValue(this.auth.header, credential.value, this.id);
      headers[this.auth.header] = this.auth.prefix ? `${this.auth.prefix} ${credential.value}` : credential.value;
    } else if (this.auth.required) {
      throw new ProviderError('AUTHENTICATION_FAILED', `Missing API key for provider ${this.id}.`, { providerId: this.id });
    }
    return headers;
  }

  protected toRequestBody(request: ChatRequest, stream: boolean) {
    assertNoProviderOptions(request, this.id);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body[this.maxTokensField] = request.maxOutputTokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools.map(toOpenAITool);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
    if (request.reasoningEffort !== undefined) body.reasoning_effort = request.reasoningEffort;
    return body;
  }

  private toChatResponse(response: OpenAIResponse, requestedModel: string): ChatResponse {
    const choice = response.choices?.[0];
    if (!choice?.message) {
      // Say which part was missing. A provider that intermittently answers with
      // an empty `choices` array is indistinguishable from one that answers with
      // a choice that has no message, and both used to read as a bare
      // "invalid response" with nothing to act on.
      const seen = Array.isArray(response.choices) ? response.choices.length : 0;
      const reason = seen === 0
        ? 'the provider returned no choices'
        : seen > 1
          ? `the provider returned ${seen} choices and the first has no message`
          : 'the provider returned a choice with no message';
      throw invalidResponse(this.id, `Provider chat response is unusable: ${reason}.`, reason);
    }

    return {
      id: response.id ?? `response-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: response.created ? new Date(response.created * 1000).toISOString() : new Date().toISOString(),
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        ...(choice.message.tool_calls?.length ? { toolCalls: choice.message.tool_calls.map(normalizeToolCall) } : {}),
      },
      finishReason: normalizeFinishReason(choice.finish_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }
}

function toOpenAIMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: toOpenAIContent(message.content),
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(toOpenAIToolCall) } : {}),
    ...(message.role === 'assistant' && message.reasoning ? { reasoning_content: message.reasoning } : {}),
  };
}

function toOpenAIContent(content: MessageContent) {
  if (content === null || typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: part.imageUrl });
}

function toOpenAITool(tool: ToolDefinition) {
  return { type: 'function', function: tool };
}

function toOpenAIToolCall(toolCall: ToolCall) {
  return { id: toolCall.id, type: 'function', function: toolCall.function };
}

function normalizeToolCall(toolCall: { id?: string; type?: string; function?: { name?: string; arguments?: string } }): ToolCall {
  return {
    id: toolCall.id ?? '',
    type: 'function',
    function: { name: toolCall.function?.name ?? '', arguments: toolCall.function?.arguments ?? '{}' },
  };
}

function normalizeToolCallDelta(toolCall: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }) {
  return {
    index: toolCall.index ?? 0,
    ...(toolCall.id ? { id: toolCall.id } : {}),
    ...(toolCall.type ? { type: 'function' as const } : {}),
    ...(toolCall.function?.name || toolCall.function?.arguments ? { function: {
      ...(toolCall.function.name ? { name: toolCall.function.name } : {}),
      ...(toolCall.function.arguments ? { arguments: toolCall.function.arguments } : {}),
    } } : {}),
  };
}

function normalizeRole(role: string): ChatMessage['role'] {
  return role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user';
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  if (reason === 'stop' || reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') return reason;
  if (reason === 'function_call') return 'tool_calls';
  return reason ? 'other' : 'other';
}

function normalizeUsage(usage: NonNullable<OpenAIResponse['usage']>): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.prompt_tokens_details.cached_tokens }),
    ...(usage.completion_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }),
  };
}

function assertNoProviderOptions(request: ChatRequest, providerId: string) {
  if (request.providerOptions && Object.keys(request.providerOptions).length > 0) {
    throw new ProviderError('INVALID_REQUEST', `Provider options are not supported by ${providerId} yet.`, { providerId });
  }
}

/**
 * The failure that ended the turn, carrying the one before it.
 *
 * The **last** error is the one a caller sees, because it is the one whose status and message describe
 * where the request stopped; the earlier one is attached as its cause rather than substituted for it. A
 * cause is only written when the error has none: a transport that already set one (a DNS failure behind an
 * unreachable host) knows more about that failure than this does, and overwriting it would trade a specific
 * cause for a less specific one.
 */
function withCause<T>(error: T, cause: unknown): T {
  if (cause !== undefined && error instanceof Error && error.cause === undefined) error.cause = cause;
  return error;
}

function providerStreamError(providerId: string, error: unknown) {
  // The provider's own sentence is the only thing that separates a content filter from a quota or an
  // expired key. Dropping it made every mid-stream refusal read identically.
  const payload = error as { message?: unknown; error?: { message?: unknown } } | undefined;
  const detail = typeof payload?.error?.message === 'string' ? payload.error.message : typeof payload?.message === 'string' ? payload.message : '';
  return new ProviderError('PROVIDER_REQUEST_FAILED', detail ? `The provider stream returned an error: ${detail}` : 'The provider stream returned an error.', { providerId });
}

/**
 * `providerMessage` is the channel the local dashboard reads. Putting the shape
 * detail there keeps it visible to the operator without putting a provider's
 * internals into the message an API client of the gateway receives.
 */
function invalidResponse(providerId: string, message: string, providerMessage?: string) {
  return new ProviderError('INVALID_RESPONSE', message, {
    providerId,
    ...(providerMessage ? { publicMessage: message, details: { providerMessage } } : {}),
  });
}
