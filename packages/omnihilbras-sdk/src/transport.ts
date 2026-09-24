import { isProviderError, ProviderError } from './errors.js';

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

export interface HttpTransport {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
  stream(request: HttpRequest): AsyncIterable<string>;
}

export type FetchHttpTransportOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
};

type RequestLifecycle = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  resetTimeout: () => void;
  cleanup: () => void;
};

const defaultTimeoutMs = 30_000;

export class FetchHttpTransport implements HttpTransport {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(options: FetchHttpTransportOptions = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProviderError('CONFIGURATION_ERROR', 'A Fetch implementation is required.');
    }

    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? options.timeoutMs ?? defaultTimeoutMs;
  }

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const lifecycle = createRequestLifecycle(request.signal, this.timeoutMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: lifecycle.signal,
      });
      const data = await parseResponse<T>(response);

      if (!response.ok) {
        throw providerErrorFromResponse(response, data, request.providerId);
      }

      return { status: response.status, headers: response.headers, data };
    } catch (error) {
      throw normalizeTransportError(error, request.signal, lifecycle);
    } finally {
      lifecycle.cleanup();
    }
  }

  async *stream(request: HttpRequest): AsyncIterable<string> {
    const lifecycle = createRequestLifecycle(request.signal, this.streamIdleTimeoutMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal: lifecycle.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw providerErrorFromResponse(response, body, request.providerId);
      }

      if (!response.body) {
        throw new ProviderError('INVALID_RESPONSE', 'Provider returned an empty response stream.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          lifecycle.resetTimeout();
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

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    resetTimeout,
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

function providerErrorFromResponse(response: Response, _body: unknown, providerId?: string): ProviderError {
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

  return new ProviderError(code, message, {
    providerId,
    statusCode: response.status,
    retryable: code === 'RATE_LIMITED' || code === 'PROVIDER_TIMEOUT' || code === 'PROVIDER_UNAVAILABLE',
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
