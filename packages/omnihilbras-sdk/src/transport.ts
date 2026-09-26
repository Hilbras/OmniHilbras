import { isProviderError, ProviderError } from './errors.js';
import { assertSafeProviderRequestUrl } from './url.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HttpRequest = {
  method: HttpMethod;
  url: string;
  providerId?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
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
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    assertSafeProviderRequestUrl(request.url, request.providerId ?? 'provider');
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
        await response.body?.cancel();
        throw providerErrorFromResponse(response, undefined, request.providerId);
      }
      const data = await parseResponse<T>(response, this.maxResponseBytes);

      return { status: response.status, headers: response.headers, data };
    } catch (error) {
      throw normalizeTransportError(error, request.signal, lifecycle);
    } finally {
      lifecycle.cleanup();
    }
  }

  async *stream(request: HttpRequest): AsyncIterable<string> {
    assertSafeProviderRequestUrl(request.url, request.providerId ?? 'provider');
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
        await response.body?.cancel();
        throw providerErrorFromResponse(response, undefined, request.providerId);
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
export function providerErrorDetail(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  let text: string | undefined;
  if (typeof body === 'string') text = body;
  else if (typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error_description', 'error', 'detail', 'reason', 'code']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) { text = value.trim(); break; }
      if (value && typeof value === 'object') {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === 'string' && nested.trim()) { text = nested.trim(); break; }
      }
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

function providerErrorFromResponse(response: Response, body: unknown, providerId?: string): ProviderError {
  const code = response.status === 401 || response.status === 403
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
          : 'The provider rejected the request.';
  const detail = providerErrorDetail(body);

  return new ProviderError(code, message, {
    providerId,
    statusCode: response.status,
    retryable: code === 'RATE_LIMITED' || code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_UNAVAILABLE',
    ...(detail ? { details: { providerMessage: detail } } : {}),
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
