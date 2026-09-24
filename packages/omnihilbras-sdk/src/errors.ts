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
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId?: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.providerId = options.providerId;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON() {
    // Provider error payloads may contain credentials or prompt data. Keep the
    // public JSON shape deliberately small; callers can inspect the original
    // error in-process when they own the adapter.
    return {
      code: this.code,
      message: this.message,
      providerId: this.providerId,
      statusCode: this.statusCode,
      retryable: this.retryable,
    };
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
