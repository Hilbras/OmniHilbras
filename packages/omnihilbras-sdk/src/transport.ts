import { isProviderError, ProviderError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HttpRequest = {
  method: HttpMethod;
  url: string;
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

export interface HttpTransport {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
  stream(request: HttpRequest): AsyncIterable<string>;
}

export type FetchHttpTransportOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
};

type RequestLifecycle = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
};

const defaultTimeoutMs = 30_000;

export class FetchHttpTransport implements HttpTransport {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: FetchHttpTransportOptions = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProviderError('CONFIGURATION_ERROR', 'A Fetch implementation is required.');
    }

    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const lifecycle = createRequestLifecycle(request.signal, this.timeoutMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: lifecycle.signal,
      });
      const data = await parseResponse<T>(response);

      if (!response.ok) {
        throw providerErrorFromResponse(response, data);
      }

      return { status: response.status, headers: response.headers, data };
    } catch (error) {
      throw normalizeTransportError(error, request.signal, lifecycle);
    } finally {
      lifecycle.cleanup();
    }
  }

  async *stream(request: HttpRequest): AsyncIterable<string> {
    const lifecycle = createRequestLifecycle(request.signal, this.timeoutMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: lifecycle.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw providerErrorFromResponse(response, body);
      }

      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            const tail = decoder.decode();
            if (tail) yield tail;
            return;
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

function createRequestLifecycle(externalSignal: AbortSignal | undefined, timeoutMs: number): RequestLifecycle {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }

  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    },
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
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

function providerErrorFromResponse(response: Response, body: unknown): ProviderError {
  const providerMessage = extractProviderMessage(body);
  const code = response.status === 401 || response.status === 403
    ? 'AUTHENTICATION_FAILED'
    : response.status === 429
      ? 'RATE_LIMITED'
      : response.status === 408 || response.status === 504
        ? 'PROVIDER_TIMEOUT'
        : response.status >= 500
          ? 'PROVIDER_UNAVAILABLE'
          : 'PROVIDER_REQUEST_FAILED';

  return new ProviderError(code, providerMessage ?? `Provider request failed with status ${response.status}.`, {
    statusCode: response.status,
    retryable: code === 'RATE_LIMITED' || code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_UNAVAILABLE',
    details: providerMessage ? { providerMessage } : undefined,
  });
}

function extractProviderMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  if (!body || typeof body !== 'object') return undefined;

  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (record.error && typeof record.error === 'object' && typeof (record.error as Record<string, unknown>).message === 'string') {
    return (record.error as Record<string, string>).message;
  }
  return undefined;
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
