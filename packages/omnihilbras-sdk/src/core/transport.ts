import { isProviderError, ProviderError, type ProviderErrorCode } from './errors.js';
import { assertSafeProviderRequestUrl, isLoopbackHostname } from './url.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HttpRequest = {
  method: HttpMethod;
  url: string;
  providerId?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * Read the body as raw bytes instead of text.
   *
   * A binary response decoded as text is silently corrupted — length prefixes and CRCs
   * are mangled by the UTF-8 decoder — and the corruption looks like a provider that
   * answered with nothing. Providers that answer in a binary framing ask for this.
   */
  responseAs?: 'bytes';
  /**
   * Return a 4xx as a result instead of throwing.
   *
   * **For OAuth token endpoints only**, where a refusal carries meaning in its body: Kimi's poll answers
   * `400 {"error":"authorization_pending"}` while the user has simply not approved yet, so throwing turns
   * "still waiting" into a failed sign-in. Measured against the live host.
   *
   * Everything else must leave this off. The throw is the transport's most useful property — it is what
   * stops a 401 being read as data — and a flag that says "read the error body anyway" is a sharp tool
   * whose whole value is being hard to reach by accident. Its two callers are the Kimi device poll and the
   * Kimi token renewal, and both are documented at their use site.
   */
  tolerateRefusalBody?: boolean;
};

export type HttpResponse<T> = {
  status: number;
  headers: Headers;
  data: T;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Low-level transport for adapter-owned, trusted provider configuration.
 * It is not an arbitrary user-URL fetcher; cloud tenant endpoints require an
 * additional allowlist and DNS-rebinding policy before exposure.
 */
export interface HttpTransport {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
  stream(request: HttpRequest): AsyncIterable<string>;
}

export type FetchHttpTransportOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxResponseBytes?: number;
  maxStreamBytes?: number;
  maxStreamDurationMs?: number;
  /**
   * Asked before a remote request is sent, with the hostname from the URL. Throw to refuse it.
   *
   * The SDK cannot resolve names itself: it is bundled into the browser dashboard, where `node:dns`
   * does not exist. A host that runs in Node supplies the check, and the gateway does. Absent, the
   * request is sent as before, so existing callers are unchanged.
   */
  checkDestination?: (hostname: string, signal?: AbortSignal) => Promise<void>;
};

type RequestLifecycle = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  resetTimeout: () => void;
  cleanup: () => void;
};

const defaultTimeoutMs = 30_000;
const defaultMaxResponseBytes = 10 * 1024 * 1024;
const defaultMaxStreamBytes = 50 * 1024 * 1024;
const defaultMaxStreamDurationMs = 10 * 60 * 1000;

export class FetchHttpTransport implements HttpTransport {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxStreamBytes: number;
  private readonly maxStreamDurationMs: number;
  private readonly checkDestination: ((hostname: string, signal?: AbortSignal) => Promise<void>) | undefined;

  constructor(options: FetchHttpTransportOptions = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProviderError('CONFIGURATION_ERROR', 'A Fetch implementation is required.');
    }

    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? options.timeoutMs ?? defaultTimeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
    this.maxStreamBytes = options.maxStreamBytes ?? defaultMaxStreamBytes;
    this.maxStreamDurationMs = options.maxStreamDurationMs ?? defaultMaxStreamDurationMs;
    this.checkDestination = options.checkDestination;
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    assertSafeProviderRequestUrl(request.url, request.providerId ?? 'provider');
    await this.assertDestination(request);
    const lifecycle = createRequestLifecycle(request.signal, this.timeoutMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: lifecycle.signal,
      });
      if (!response.ok) {
        /**
         * The error body is the only place a provider explains itself, and it used to be
         * cancelled unread, so every refusal arrived as "the provider rejected the
         * request" with no reason attached. It is read here, bounded, and handed to the
         * classifier.
         *
         * With `tolerateRefusalBody` the read *becomes* the result and the request returns, because an
         * OAuth token endpoint's refusal is data. Reading it here and then reading the body again below
         * was the first attempt and it fails in a way that hides itself: the second read sees a consumed
         * stream, throws, and `normalizeTransportError` reports `PROVIDER_UNAVAILABLE` — which reads as
         * "Kimi is down" rather than "Kimi said no".
         */
        let body: unknown;
        try {
          body = await parseResponse<unknown>(response, Math.min(this.maxResponseBytes, maxErrorBodyBytes));
        } catch {
          body = undefined;
        }
        // Opted out only by an OAuth token exchange, where a 4xx body *is* the answer. A 5xx carries no answer:
        // it is an outage in front of the endpoint, and is classified like any other.
        const refusal = response.status >= 400 && response.status < 500;
        if (!request.tolerateRefusalBody || !refusal) throw providerErrorFromResponse(response, body, request.providerId);
        return { status: response.status, headers: response.headers, data: body as T };
      }
      const data =
        request.responseAs === 'bytes'
          ? ((await readResponseBytes(response, this.maxResponseBytes)) as T)
          : await parseResponse<T>(response, this.maxResponseBytes);

      return { status: response.status, headers: response.headers, data };
    } catch (error) {
      throw normalizeTransportError(error, request.signal, lifecycle);
    } finally {
      lifecycle.cleanup();
    }
  }

  /**
   * Refuses a remote destination the host's check rejects, with the same error shape as the URL check.
   *
   * Loopback hosts are not checked here. They are the deliberate local-inference exemption, and a
   * check that refused them would break the default compatible base (`localhost`).
   */
  private async assertDestination(request: HttpRequest) {
    if (!this.checkDestination) return;
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, '');
    if (isLoopbackHostname(hostname)) return;
    try {
      await this.checkDestination(hostname, request.signal);
    } catch (error) {
      if (request.signal?.aborted) {
        throw new ProviderError('CANCELLED', 'The provider request was cancelled.', { providerId: request.providerId, cause: error });
      }
      if (isTemporaryDnsFailure(error)) {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'The provider destination could not be resolved.', {
          providerId: request.providerId,
          cause: error,
          retryable: true,
        });
      }
      throw new ProviderError('CONFIGURATION_ERROR', `Provider destination refused for ${request.providerId ?? 'provider'}.`, {
        providerId: request.providerId,
        cause: error,
      });
    }
  }

  async *stream(request: HttpRequest): AsyncIterable<string> {
    assertSafeProviderRequestUrl(request.url, request.providerId ?? 'provider');
    await this.assertDestination(request);
    const lifecycle = createRequestLifecycle(request.signal, this.streamIdleTimeoutMs, this.maxStreamDurationMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: lifecycle.signal,
      });

      if (!response.ok) {
        // Same as the request path: a provider's explanation is in the body it is about
        // to discard, so it is read before the stream is dropped.
        let body: unknown;
        try {
          body = await readResponseText(response, maxErrorBodyBytes).then((text) => {
            if (!text) return undefined;
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          });
        } catch {
          body = undefined;
        }
        throw providerErrorFromResponse(response, body, request.providerId);
      }

      if (!response.body) {
        throw new ProviderError('INVALID_RESPONSE', 'Provider returned an empty response stream.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;

      try {
        while (true) {
          lifecycle.resetTimeout();
          const result = await reader.read();
          if (result.done) {
            const tail = decoder.decode();
            if (tail) yield tail;
            return;
          }

          totalBytes += result.value.byteLength;
          if (totalBytes > this.maxStreamBytes) {
            throw new ProviderError('INVALID_RESPONSE', 'Provider response stream exceeded the configured size limit.');
          }
          const text = decoder.decode(result.value, { stream: true });
          if (text) yield text;
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed by the provider.
        }
        reader.releaseLock();
      }
    } catch (error) {
      throw normalizeTransportError(error, request.signal, lifecycle);
    } finally {
      lifecycle.cleanup();
    }
  }
}

function createRequestLifecycle(externalSignal: AbortSignal | undefined, timeoutMs: number, maxDurationMs = 0): RequestLifecycle {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;

  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason);
  };

  const resetTimeout = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (timeoutMs > 0 && !controller.signal.aborted) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
  };

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  resetTimeout();
  if (maxDurationMs > 0 && !controller.signal.aborted) {
    durationTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, maxDurationMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    resetTimeout,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (durationTimer) clearTimeout(durationTimer);
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    },
  };
}

/** Error bodies are read, so they need their own bound. */
const maxErrorBodyBytes = 64 * 1024;

async function parseResponse<T>(response: Response, maxBytes: number): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await readResponseText(response, maxBytes);
  if (!text) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (!response.ok) return text as T;
    throw new ProviderError('INVALID_RESPONSE', 'Provider returned a non-JSON response.', {
      statusCode: response.status,
      cause: error,
    });
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      // Bounded exactly like the text path, so a binary response cannot stream forever.
      if (totalBytes > maxBytes) throw new ProviderError('INVALID_RESPONSE', 'Provider response exceeded the configured size limit.');
      chunks.push(result.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The provider may have already closed the response.
    }
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readResponseText(response: Response, maxBytes: number) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return text + decoder.decode();
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) throw new ProviderError('INVALID_RESPONSE', 'Provider response exceeded the configured size limit.');
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The provider may have already closed the response.
    }
    reader.releaseLock();
  }
}

/**
 * A short, safe excerpt of what the provider actually said.
 *
 * Without this a provider that answers 4xx is indistinguishable from one that
 * answers 401, which makes an integration bug undebuggable: the only symptom is
 * a generic "the provider rejected the request". Token-shaped strings are
 * stripped so an error can be shown to a user or written to a log.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function providerErrorDetail(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  let text: string | undefined;
  if (typeof body === 'string') text = body;
  else if (typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error_description', 'error', 'detail', 'reason', 'code', 'msg', 'title']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) { text = value.trim(); break; }
      if (value && typeof value === 'object') {
        // `{"error":{"type":"AuthError","message":"..."}}` and the
        // `{"error":{"type":"AuthError"}}` shape that carries only a type.
        const nested = value as Record<string, unknown>;
        for (const inner of ['message', 'description', 'detail', 'type']) {
          if (typeof nested[inner] === 'string' && (nested[inner] as string).trim()) { text = (nested[inner] as string).trim(); break; }
        }
        if (text) break;
      }
    }
    // A validation-style list: `{"errors":[{"message":"..."}]}`.
    if (!text && Array.isArray(record.errors)) {
      const first = record.errors.find((entry) => isRecord(entry) && typeof entry.message === 'string');
      if (first) text = String((first as { message: string }).message).trim();
    }
  }
  if (!text) return undefined;
  // Drop anything token-shaped, then keep it short and printable.
  const cleaned = text
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, '[redacted]')
    .replace(/\b(?:sk|clp|ohk|key|tok)[-_][A-Za-z0-9_-]{16,}/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 200) : undefined;
}

/**
 * The wait a provider asked for in `Retry-After`, in milliseconds, or undefined when it asked for none.
 *
 * RFC 9110 allows delay-seconds or an HTTP date. A value that is neither, or a date already past, is
 * treated as no advice rather than a zero wait, so a malformed header cannot make the gateway retry at once.
 */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const wait = at - now;
  return wait > 0 ? wait : undefined;
}

function retryAfterDetail(code: ProviderErrorCode, response: Response): { retryAfterMs?: number } {
  if (code !== 'RATE_LIMITED') return {};
  const retryAfter = retryAfterMs(response.headers.get('retry-after'));
  return retryAfter === undefined ? {} : { retryAfterMs: retryAfter };
}

function providerErrorFromResponse(response: Response, body: unknown, providerId?: string): ProviderError {
  /**
   * A 403 is a refusal, not proof that the credential is bad.
   *
   * Treating it as an authentication failure was actively harmful: that code is terminal
   * for routing, so a single refused request ejected the whole connection and took every
   * working model with it. A real credential failure is a 401, and a provider that knows
   * a particular 403 *is* an auth failure says so itself — Cline and OpenRouter both
   * raise `AUTHENTICATION_FAILED` deliberately rather than relying on the status.
   */
  const code = response.status === 401
    ? 'AUTHENTICATION_FAILED'
    : response.status === 429
      ? 'RATE_LIMITED'
      : response.status === 408 || response.status === 504
        ? 'PROVIDER_TIMEOUT'
        : response.status >= 500
          ? 'PROVIDER_UNAVAILABLE'
          : 'PROVIDER_REQUEST_FAILED';

  const message = code === 'AUTHENTICATION_FAILED'
    ? 'Provider authentication failed.'
    : code === 'RATE_LIMITED'
      ? 'The provider rate limit was reached.'
      : code === 'PROVIDER_TIMEOUT'
        ? 'The provider request timed out.'
        : code === 'PROVIDER_UNAVAILABLE'
          ? 'The provider is temporarily unavailable.'
          : response.status === 403
            ? 'The provider refused the request.'
            : 'The provider rejected the request.';
  // Say so when the provider refuses without saying why. A bare 403 with an
  // empty body is the least actionable response there is, and silence reads as a
  // gateway problem rather than a refusal that reached the provider.
  const detail = providerErrorDetail(body) ?? `HTTP ${response.status} with an empty response body`;

  return new ProviderError(code, message, {
    providerId,
    statusCode: response.status,
    retryable: code === 'RATE_LIMITED' || code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_UNAVAILABLE',
    ...(detail ? { details: { providerMessage: detail, ...retryAfterDetail(code, response) } } : {}),
  });
}

function normalizeTransportError(error: unknown, requestSignal: AbortSignal | undefined, lifecycle: RequestLifecycle): ProviderError {
  if (isProviderError(error)) return error;
  if (lifecycle.didTimeout()) {
    return new ProviderError('PROVIDER_TIMEOUT', 'The provider request timed out.', { cause: error, retryable: true });
  }
  if (requestSignal?.aborted || isAbortError(error)) {
    return new ProviderError('CANCELLED', 'The provider request was cancelled.', { cause: error });
  }
  return new ProviderError('PROVIDER_UNAVAILABLE', 'The provider could not be reached.', { cause: error, retryable: true });
}

function isTemporaryDnsFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EAI_AGAIN';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
