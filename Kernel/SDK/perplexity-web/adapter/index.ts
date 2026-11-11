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
 * Perplexity Web, through the session cookie a signed-in browser holds.
 *
 * This is the old project's `open-sse/executors/perplexity-web.js` ported onto the
 * gateway's adapter contract. Perplexity has no API that accepts this credential:
 * `__Secure-next-auth.session-token` is a live NextAuth session for a whole account,
 * and the endpoint below is the web app's own ask route.
 *
 * The upstream is SSE. The old executor understood four things about it that the
 * adapter keeps:
 *
 * - `blocks[].markdown_block.chunks` can be cumulative; the parser compares lengths
 *   rather than appending blindly.
 * - `pro_direct` search steps and plan goals arrive as thinking text, not the answer.
 * - `[1]` citations and `<grok:...>`/`<response>` markers are UI scaffolding and are
 *   removed from the answer.
 * - `backend_uuid` is how a follow-up continues the same Perplexity thread; it is
 *   cached by a bounded history key, so one gateway process cannot grow it forever.
 */

export const perplexityWebProviderId = 'perplexity-web';
export const PERPLEXITY_WEB_ORIGIN = 'https://www.perplexity.ai';
export const PERPLEXITY_WEB_ENDPOINT = `${PERPLEXITY_WEB_ORIGIN}/rest/sse/perplexity_ask`;
export const PERPLEXITY_WEB_COOKIE = '__Secure-next-auth.session-token';

const API_VERSION = '2.18';
const DEFAULT_MODEL = 'pplx-auto';
const SESSION_MAX_AGE_MS = 3_600_000;
const SESSION_MAX_ENTRIES = 200;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MODEL_MAP: Record<string, [mode: string, preference: string]> = {
  'pplx-auto': ['concise', 'pplx_pro'],
  'pplx-sonar': ['copilot', 'experimental'],
  'pplx-gpt': ['copilot', 'gpt54'],
  'pplx-gemini': ['copilot', 'gemini31pro_high'],
  'pplx-sonnet': ['copilot', 'claude46sonnet'],
  'pplx-opus': ['copilot', 'claude46opus'],
  'pplx-nemotron': ['copilot', 'nv_nemotron_3_super'],
};

const THINKING_MAP: Record<string, string> = {
  'pplx-gpt': 'gpt54_thinking',
  'pplx-sonnet': 'claude46sonnetthinking',
  'pplx-opus': 'claude46opusthinking',
};

export const PERPLEXITY_WEB_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'pplx-auto', name: 'Perplexity Auto (Free)' },
  { id: 'pplx-sonar', name: 'Perplexity Sonar' },
  { id: 'pplx-gpt', name: 'GPT-5.4 (via Perplexity)' },
  { id: 'pplx-gemini', name: 'Gemini 3.1 Pro (via Perplexity)' },
  { id: 'pplx-sonnet', name: 'Claude Sonnet 4.6 (via Perplexity)' },
  { id: 'pplx-opus', name: 'Claude Opus 4.6 (via Perplexity)' },
  { id: 'pplx-nemotron', name: 'Nemotron 3 Super (via Perplexity)' },
];

const CITATION_RE = /\[\d+\]/g;
const GROK_TAG_RE = /<grok:[^>]*>.*?<\/grok:[^>]*>/gs;
const GROK_SELF_RE = /<grok:[^>]*\/>/g;
const XML_DECL_RE = /<[?]xml[^?]*[?]>/g;
const RESPONSE_TAG_RE = /<\/?response\b[^>]*>/gi;
const MULTI_SPACE = / {2,}/g;
const MULTI_NL = /\n{3,}/g;

/** A pasted Cookie header, a lone session token, or a `name=value` pair. */
export function normalizePerplexityCookie(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/^cookie:\s*/i, '').trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the Perplexity session cookie.', {
      providerId: perplexityWebProviderId,
      publicMessage: `Paste the value of \`${PERPLEXITY_WEB_COOKIE}\` from perplexity.ai, or a whole Cookie header.`,
    });
  }
  if (trimmed.includes('=')) return trimmed;
  return `${PERPLEXITY_WEB_COOKIE}=${trimmed}`;
}

export function perplexityWebCredential(raw: string): ProviderCredential {
  return { type: 'api-key', value: normalizePerplexityCookie(raw) };
}

function cookieFromCredential(credential: ProviderCredential | undefined): string {
  if (credential?.type !== 'api-key' || !credential.value.trim()) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'No Perplexity session cookie was supplied.', {
      providerId: perplexityWebProviderId,
      publicMessage: 'Connect Perplexity Web with a session cookie first.',
    });
  }
  return normalizePerplexityCookie(credential.value);
}

function refusal(status: number, what: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('AUTHENTICATION_FAILED', `Perplexity refused the session while ${what} (${status}).`, {
      providerId: perplexityWebProviderId,
      statusCode: status,
      publicMessage: `Perplexity did not accept this session. Sign in at perplexity.ai and paste a fresh ${PERPLEXITY_WEB_COOKIE}.`,
    });
  }
  if (status === 429) {
    return new ProviderError('RATE_LIMITED', `Perplexity is rate limiting this session while ${what} (${status}).`, {
      providerId: perplexityWebProviderId,
      statusCode: status,
      retryable: true,
      publicMessage: 'Perplexity is rate limiting requests. Wait a moment and try again.',
    });
  }
  if (status >= 500) {
    return new ProviderError('PROVIDER_UNAVAILABLE', `Perplexity answered ${status} while ${what}.`, {
      providerId: perplexityWebProviderId,
      statusCode: status,
      retryable: true,
    });
  }
  return new ProviderError('PROVIDER_REQUEST_FAILED', `Perplexity answered ${status} while ${what}.`, {
    providerId: perplexityWebProviderId,
    statusCode: status,
    publicMessage: `Perplexity refused the request (${status}).`,
  });
}

function normalizeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ProviderError('CANCELLED', 'The Perplexity request was cancelled.', { providerId: perplexityWebProviderId });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError('PROVIDER_REQUEST_FAILED', `Perplexity Web could not be reached: ${message}`, {
    providerId: perplexityWebProviderId,
    publicMessage: 'Perplexity Web could not be reached. Check the network and the session cookie.',
    cause: error,
  });
}

export function cleanPerplexityResponse(text: string, strip = true): string {
  let value = text.replace(XML_DECL_RE, '').replace(CITATION_RE, '').replace(GROK_TAG_RE, '').replace(GROK_SELF_RE, '');
  value = value.replace(RESPONSE_TAG_RE, '');
  if (strip) value = value.replace(MULTI_SPACE, ' ').replace(MULTI_NL, '\n\n').trim();
  return value;
}

export function perplexitySessionKey(history: ReadonlyArray<{ role: string; content: string }>): string {
  const parts = history.map((item) => `${item.role}:${item.content}`).join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < parts.length; index += 1) {
    hash ^= parts.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

type ParsedMessages = {
  system: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  current: string;
};

/** OpenAI messages → the instructions/history/query object the ask endpoint takes. */
export function parsePerplexityMessages(messages: readonly ChatMessage[]): ParsedMessages {
  let system = '';
  const history: ParsedMessages['history'] = [];
  for (const message of messages) {
    const role = message.role;
    const content = flattenContent(message.content);
    if (!content.trim()) continue;
    if (role === 'system') system += `${content}\n`;
    else if (role === 'user' || role === 'assistant') history.push({ role, content });
    else if (role === 'tool') history.push({ role: 'user', content });
  }
  let current = '';
  if (history.at(-1)?.role === 'user') current = history.pop()!.content;
  return { system, history, current };
}

function flattenContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ? String(content) : '';
  return content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function buildPerplexityQuery(parsed: ParsedMessages, followUpUuid: string | null, tools: ChatRequest['tools']): string {
  if (followUpUuid) return parsed.current;
  const instructions: string[] = [];
  if (parsed.system.trim()) instructions.push(parsed.system.trim());
  const toolsHint = formatToolsHint(tools);
  if (toolsHint) instructions.push(toolsHint);
  instructions.push('You have built-in web search. Answer questions directly using search results.');
  const payload: Record<string, unknown> = { instructions };
  if (parsed.history.length > 0) payload.history = parsed.history;
  payload.query = parsed.current;
  const text = JSON.stringify(payload);
  return text.length > 96_000 ? text.slice(-96_000) : text;
}

function formatToolsHint(tools: ChatRequest['tools']): string {
  if (!tools?.length) return '';
  return [
    'Available tools (reference only, cannot invoke):',
    ...tools.map((tool) => `- ${tool.name}: ${(tool.description ?? '').split('\n')[0]?.slice(0, 200) ?? ''}`),
  ].join('\n');
}

export function buildPerplexityBody(query: string, mode: string, model: string, followUpUuid: string | null) {
  return {
    query_str: query,
    params: {
      query_str: query,
      search_focus: 'internet',
      mode,
      model_preference: model,
      sources: ['web'],
      attachments: [],
      frontend_uuid: crypto.randomUUID(),
      frontend_context_uuid: crypto.randomUUID(),
      version: API_VERSION,
      language: 'en-US',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      search_recency_filter: null,
      is_incognito: true,
      use_schematized_api: true,
      last_backend_uuid: followUpUuid,
    },
  };
}

type SseEvent = Record<string, unknown>;

/** Reads an SSE body and yields its JSON `data:` payloads. */
export async function* readPerplexitySse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const flush = (): SseEvent | 'done' | undefined => {
    if (dataLines.length === 0) return undefined;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (!payload || payload === '[DONE]') return 'done';
    try {
      return JSON.parse(payload) as SseEvent;
    } catch {
      return undefined;
    }
  };
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const raw = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line === '') {
          const parsed = flush();
          if (parsed === 'done') return;
          if (parsed) yield parsed;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line === 'event: end_of_stream') {
          return;
        }
        at = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith('data:')) dataLines.push(buffer.trim().slice(5).trimStart());
    const tail = flush();
    if (tail && tail !== 'done') yield tail;
  } finally {
    reader.releaseLock();
  }
}

type Extracted =
  | { kind: 'delta'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'done'; answer: string; backendUuid?: string }
  | { kind: 'error'; message: string };

export async function* extractPerplexityContent(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Extracted> {
  let answer = '';
  let backendUuid: string | undefined;
  let seenLength = 0;
  const seenThinking = new Set<string>();

  for await (const event of readPerplexitySse(body, signal)) {
    const errorCode = typeof event.error_code === 'string' ? event.error_code : undefined;
    const errorMessage = typeof event.error_message === 'string' ? event.error_message : undefined;
    if (errorCode || errorMessage) {
      yield { kind: 'error', message: errorMessage ?? `Perplexity error: ${errorCode}` };
      return;
    }
    if (typeof event.backend_uuid === 'string') backendUuid = event.backend_uuid;

    const blocks = Array.isArray(event.blocks) ? event.blocks : [];
    for (const item of blocks) {
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      const usage = typeof block.intended_usage === 'string' ? block.intended_usage : '';

      if (usage === 'pro_search_steps' && block.plan_block && typeof block.plan_block === 'object') {
        const steps = (block.plan_block as { steps?: unknown }).steps;
        if (Array.isArray(steps)) {
          for (const step of steps) {
            if (!step || typeof step !== 'object') continue;
            const record = step as Record<string, unknown>;
            if (record.step_type === 'SEARCH_WEB') {
              const queries = (record.search_web_content as { queries?: unknown } | undefined)?.queries;
              if (Array.isArray(queries)) {
                for (const value of queries) {
                  const query = (value as { query?: unknown } | undefined)?.query;
                  if (typeof query === 'string' && query && !seenThinking.has(query)) {
                    seenThinking.add(query);
                    yield { kind: 'thinking', text: `Searching: ${query}` };
                  }
                }
              }
            } else if (record.step_type === 'READ_RESULTS') {
              const urls = (record.read_results_content as { urls?: unknown } | undefined)?.urls;
              if (Array.isArray(urls)) {
                for (const value of urls.slice(0, 3)) {
                  if (typeof value === 'string' && value && !seenThinking.has(value)) {
                    seenThinking.add(value);
                    yield { kind: 'thinking', text: `Reading: ${value}` };
                  }
                }
              }
            }
          }
        }
      }

      if (usage === 'plan' && block.plan_block && typeof block.plan_block === 'object') {
        const goals = (block.plan_block as { goals?: unknown }).goals;
        if (Array.isArray(goals)) {
          for (const value of goals) {
            const description = (value as { description?: unknown } | undefined)?.description;
            if (typeof description === 'string' && description && !seenThinking.has(description)) {
              seenThinking.add(description);
              yield { kind: 'thinking', text: description };
            }
          }
        }
      }

      if (!usage.includes('markdown')) continue;
      const markdown = block.markdown_block;
      if (!markdown || typeof markdown !== 'object') continue;
      const record = markdown as { chunks?: unknown; progress?: unknown };
      const chunks = Array.isArray(record.chunks) ? record.chunks.map((chunk) => String(chunk ?? '')).join('') : '';
      if (!chunks) continue;
      if (record.progress === 'DONE') {
        answer = chunks;
        seenLength = chunks.length;
        continue;
      }
      const cumulative = answer + chunks;
      if (cumulative.length > seenLength) {
        const delta = cumulative.slice(seenLength);
        answer = cumulative;
        seenLength = cumulative.length;
        yield { kind: 'delta', text: delta };
      }
    }

    if (blocks.length === 0 && typeof event.text === 'string') {
      const text = event.text.trim();
      if (text.length > seenLength) {
        const delta = text.slice(seenLength);
        answer = text;
        seenLength = text.length;
        yield { kind: 'delta', text: delta };
      }
    }

    if (event.final === true || event.status === 'COMPLETED') break;
  }
  yield { kind: 'done', answer, ...(backendUuid ? { backendUuid } : {}) };
}

type Prepared = { model: string; body: unknown; parsed: ParsedMessages };

export class PerplexityWebAdapter implements ProviderAdapter {
  readonly id = perplexityWebProviderId;
  readonly name = 'Perplexity Web';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, { backendUuid: string; at: number }>();

  constructor(options: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(): Promise<Model[]> {
    return PERPLEXITY_WEB_MODELS.map((model) => ({ id: model.id, providerId: this.id, displayName: model.name }));
  }

  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const cookie = cookieFromCredential(credential);
    const response = await this.requestProbe(cookie, context.signal);
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
        message: error instanceof Error ? error.message : 'The Perplexity session could not be checked.',
      };
    }
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const prepared = this.prepare(request);
    const cookie = cookieFromCredential(context.credential);
    const response = await this.openTurn(prepared, cookie, context.signal);
    if (!response.body) throw new ProviderError('INVALID_RESPONSE', 'Perplexity returned no response body.', { providerId: this.id });

    let content = '';
    let reasoning = '';
    let backendUuid: string | undefined;
    for await (const chunk of extractPerplexityContent(response.body, context.signal)) {
      if (chunk.kind === 'error') throw new ProviderError('PROVIDER_REQUEST_FAILED', `Perplexity refused the turn: ${chunk.message}`, { providerId: this.id });
      if (chunk.kind === 'thinking') reasoning += `${chunk.text}\n`;
      if (chunk.kind === 'delta') content += chunk.text;
      if (chunk.kind === 'done') {
        content = chunk.answer || content;
        backendUuid = chunk.backendUuid;
      }
    }
    const answer = cleanPerplexityResponse(content);
    if (!answer) throw new ProviderError('INVALID_RESPONSE', 'Perplexity answered, but the stream carried no answer text.', { providerId: this.id });
    this.rememberSession(prepared, answer, backendUuid);
    const inputTokens = Math.ceil(prepared.parsed.current.length / 4);
    const outputTokens = Math.ceil(answer.length / 4);
    return {
      id: `chatcmpl-pplx-${Math.floor(this.now() / 1000)}`,
      providerId: this.id,
      model: prepared.model,
      createdAt: new Date(this.now()).toISOString(),
      message: { role: 'assistant', content: answer, ...(reasoning.trim() ? { reasoning: cleanPerplexityResponse(reasoning) } : {}) },
      finishReason: 'stop' satisfies FinishReason,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true },
    };
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const prepared = this.prepare(request);
    const cookie = cookieFromCredential(context.credential);
    const response = await this.openTurn(prepared, cookie, context.signal);
    if (!response.body) throw new ProviderError('INVALID_RESPONSE', 'Perplexity returned no response body.', { providerId: this.id });

    const id = `chatcmpl-pplx-${Math.floor(this.now() / 1000)}`;
    let content = '';
    let finalAnswer = '';
    let backendUuid: string | undefined;
    let started = false;
    for await (const chunk of extractPerplexityContent(response.body, context.signal)) {
      if (chunk.kind === 'error') throw new ProviderError('PROVIDER_REQUEST_FAILED', `Perplexity refused the turn: ${chunk.message}`, { providerId: this.id });
      if (chunk.kind === 'thinking') continue;
      if (chunk.kind === 'done') {
        finalAnswer = chunk.answer;
        backendUuid = chunk.backendUuid;
        break;
      }
      if (chunk.kind !== 'delta') continue;
      content += chunk.text;
      if (!started) {
        started = true;
        yield { id, providerId: this.id, model: prepared.model, delta: { role: 'assistant', content: chunk.text } };
      } else {
        yield { id, providerId: this.id, model: prepared.model, delta: { content: chunk.text } };
      }
    }
    // A stream that only sent the final DONE block has no deltas to forward. Yield the
    // completed answer once rather than returning an empty stream.
    if (!started && finalAnswer) {
      started = true;
      yield { id, providerId: this.id, model: prepared.model, delta: { role: 'assistant', content: cleanPerplexityResponse(finalAnswer) } };
    }
    this.rememberSession(prepared, cleanPerplexityResponse(finalAnswer || content), backendUuid);
    yield { id, providerId: this.id, model: prepared.model, delta: {}, finishReason: 'stop' };
  }

  private prepare(request: ChatRequest): Prepared {
    const messages = request.messages ?? [];
    if (messages.length === 0) throw new ProviderError('INVALID_REQUEST', 'Perplexity Web needs at least one message.', { providerId: this.id });
    const parsed = parsePerplexityMessages(messages);
    if (!parsed.current.trim()) throw new ProviderError('INVALID_REQUEST', 'Perplexity Web needs a user message.', { providerId: this.id });
    const model = request.model?.trim() || DEFAULT_MODEL;
    const thinking = request.reasoningEffort !== undefined || (request.providerOptions?.thinking === true);
    const mapped = MODEL_MAP[model];
    const mode = thinking && THINKING_MAP[model] ? 'copilot' : mapped?.[0] ?? 'copilot';
    const preference = thinking && THINKING_MAP[model] ? THINKING_MAP[model]! : mapped?.[1] ?? model;
    const followUp = this.lookupSession(parsed.history);
    const query = buildPerplexityQuery(parsed, followUp, request.tools);
    return { model, parsed, body: buildPerplexityBody(query, mode, preference, followUp) };
  }

  private async openTurn(prepared: Prepared, cookie: string, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(PERPLEXITY_WEB_ENDPOINT, {
        method: 'POST',
        headers: this.headers(cookie, true),
        body: JSON.stringify(prepared.body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw normalizeError(error);
    }
    if (!response.ok) throw refusal(response.status, 'answering the completion');
    return response;
  }

  private async requestProbe(cookie: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(PERPLEXITY_WEB_ENDPOINT, {
        method: 'POST',
        headers: this.headers(cookie, true),
        body: JSON.stringify(buildPerplexityBody('ping', 'concise', 'pplx_pro', null)),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  private headers(cookie: string, sse: boolean): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: sse ? 'text/event-stream' : 'application/json',
      origin: PERPLEXITY_WEB_ORIGIN,
      referer: `${PERPLEXITY_WEB_ORIGIN}/`,
      'user-agent': USER_AGENT,
      'x-app-apiclient': 'default',
      'x-app-apiversion': API_VERSION,
      Cookie: cookie,
    };
  }

  private lookupSession(history: ReadonlyArray<{ role: string; content: string }>): string | null {
    if (history.length === 0) return null;
    const key = perplexitySessionKey(history);
    const entry = this.sessions.get(key);
    if (!entry) return null;
    if (this.now() - entry.at > SESSION_MAX_AGE_MS) {
      this.sessions.delete(key);
      return null;
    }
    return entry.backendUuid;
  }

  private rememberSession(prepared: Prepared, answer: string, backendUuid: string | undefined): void {
    if (!backendUuid) return;
    const key = perplexitySessionKey([...prepared.parsed.history, { role: 'user', content: prepared.parsed.current }, { role: 'assistant', content: answer }]);
    this.sessions.set(key, { backendUuid, at: this.now() });
    if (this.sessions.size > SESSION_MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidate, entry] of this.sessions) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = candidate;
        }
      }
      if (oldestKey) this.sessions.delete(oldestKey);
    }
  }
}
