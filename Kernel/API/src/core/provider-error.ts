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

/**
 * Whether a thrown value is a `ProviderError` — **including one from another copy of this class**.
 *
 * `instanceof` is the obvious test and it is wrong here. Every provider is its own package with its own
 * `errors.ts`, so the class that a provider throws is not the class the gateway imported: measured,
 * `sdkCopy === apiCopy` is `false` and `error instanceof api.ProviderError` is `false` for a perfectly
 * valid provider error. The consequence was not cosmetic — `toErrorEnvelope` fell through to its
 * catch-all, so a refused cookie was reported to the user as
 * "The gateway encountered an unexpected error" instead of the reason, with no status, no code, and no
 * provider named.
 *
 * Branding on `name` is the portable test: every copy sets it in its constructor, and it survives a
 * second module instance, a bundled copy, and a package boundary — none of which `instanceof` survives.
 * The `code` check keeps a stray `Error` that merely named itself from passing.
 */
export function isProviderError(error: unknown): error is ProviderError {
  if (error instanceof ProviderError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ProviderError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
