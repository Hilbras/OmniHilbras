export type ProviderErrorCode =
  | 'NOT_SUPPORTED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'RATE_LIMITED'
  | 'PROVIDER_REQUEST_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'CANCELLED'
  | 'CONFIGURATION_ERROR';

export type ProviderErrorOptions = {
  providerId?: string;
  statusCode?: number;
  retryable?: boolean;
  details?: unknown;
  publicMessage?: string;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId?: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly publicMessage?: string;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.providerId = options.providerId;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    Object.defineProperty(this, 'publicMessage', {
      value: options.publicMessage,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(this, 'details', {
      value: options.details,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  toJSON() {
    // Provider error payloads may contain credentials or prompt data. Keep the
    // public JSON shape deliberately small; callers can inspect the original
    // error in-process when they own the adapter.
    return {
      code: this.code,
      message: this.publicMessage ?? publicProviderMessage(this.code),
      providerId: this.providerId,
      statusCode: this.statusCode,
      retryable: this.retryable,
    };
  }
}

export function publicProviderMessage(code: ProviderErrorCode) {
  switch (code) {
    case 'AUTHENTICATION_FAILED': return 'Provider authentication failed.';
    case 'RATE_LIMITED': return 'The provider rate limit was reached.';
    case 'PROVIDER_TIMEOUT': return 'The provider request timed out.';
    case 'PROVIDER_UNAVAILABLE': return 'The provider is temporarily unavailable.';
    case 'CANCELLED': return 'The request was cancelled.';
    case 'INVALID_RESPONSE': return 'The provider returned an invalid response.';
    case 'NOT_SUPPORTED': return 'This provider does not support the requested capability.';
    case 'NOT_FOUND': return 'The requested resource was not found.';
    case 'INVALID_REQUEST': return 'The request is invalid.';
    case 'CONFIGURATION_ERROR': return 'The provider is not configured correctly.';
    case 'PROVIDER_REQUEST_FAILED':
    default: return 'The provider request failed.';
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
