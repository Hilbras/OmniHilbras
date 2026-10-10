import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProviderError, publicProviderMessage, type ModelImportPolicy } from '@hilbras/omnihilbras';
import { claudeCodeCallbackPath, clineCallbackPath } from './oauth.js';
import type { GatewayServerOptions } from './server.js';

/**
 * The HTTP vocabulary every route shares.
 *
 * Extracted from `server.ts`, which held 717 lines of helpers below a 373-line if-chain. Nothing
 * here knows what a route *means* — only how a request is read, a response is written, and a
 * failure becomes an envelope. The rule it exists to keep: a route module decides *which* resource
 * and never how the bytes get there.
 *
 * `sendJson` alone is called from 43 places across all five route modules, so it was the most
 * reached function in the file and the clearest evidence that these helpers were a shared layer
 * that had simply never been separated from the routes using them.
 */

export const defaultCorsOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
/** A connection body carries an endpoint and a model list, so it gets more room than a key. */
export const maxConnectionBodyBytes = 16 * 1024;
export const maxKeyBodyBytes = 4 * 1024;
export const maxPresentedKeyLength = 512;

export async function readJsonBody(request: IncomingMessage, maxBytes: number) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw invalidRequest('Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw invalidRequest('Request body is too large.');
    chunks.push(buffer);
  }
  if (size === 0) throw invalidRequest('Request body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw invalidRequest('Request body must contain valid JSON.');
  }
}


export function resolveCorsOrigins(options: GatewayServerOptions) {
  const configured = options.corsOrigins ?? (options.corsOrigin ? [options.corsOrigin] : defaultCorsOrigins);
  const origins = [...new Set(configured.map((origin) => origin.trim()).filter(Boolean))];
  if (origins.includes('*')) throw new Error('Wildcard CORS is not allowed for the local gateway.');
  return origins;
}


export function getRequestOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : undefined;
}

export function isCrossSiteRequest(request: IncomingMessage) {
  return request.headers['sec-fetch-site'] === 'cross-site';
}

/**
 * The GET navigations an OAuth provider is allowed to redirect the browser to.
 *
 * Two guards consult this, and they have to agree. The cross-site guard exempts
 * the callback because a top-level navigation carries `sec-fetch-site: cross-site`
 * and no `Origin`; the API-key gate exempts it because that same navigation has
 * no way to carry an `Authorization` header either. Naming the paths once is what
 * stops one guard learning about the callback and the other not — which is not a
 * tidy-up: the callback lives under `/v1/oauth`, and it served the API-key gate's
 * "This gateway requires an API key" error to every user with enforcement on until
 * both agreed.
 *
 * The page it identifies renders an outcome message and no credential, so what the
 * exemption exposes is a status page, not a session.
 */
export function isOauthCallbackNavigation(request: IncomingMessage) {
  if (request.method !== 'GET') return false;
  // Normalised the way routing normalises it. Testing the raw string let `/callback/x/../../connections` pass
  // the prefix check and then route to the management endpoint, with no key.
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  // Both redirect providers land here as a top-level navigation from the provider, so both carry
  // `sec-fetch-site: cross-site` and no `Origin`. The exemption is by path, and each path is the
  // gateway's own constant — never a value from the request.
  return path === clineCallbackPath || path.startsWith(`${clineCallbackPath}/`)
    || path === claudeCodeCallbackPath || path.startsWith(`${claudeCodeCallbackPath}/`);
}


export function isJsonRequest(request: IncomingMessage) {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && (contentType.split(';', 1)[0] ?? '').trim().toLowerCase() === 'application/json';
}


export function setCors(response: ServerResponse, origin: string | undefined) {
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'content-type, x-omnihilbras-provider, authorization, x-api-key, x-goog-api-key');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('vary', 'Origin');
}


export function sendJson(response: ServerResponse, status: number, body: unknown, origin?: string) {
  const payload = JSON.stringify(body);
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}


export function sendHtml(response: ServerResponse, status: number, html: string, origin?: string) {
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    // This page lives on the origin that also holds credentials, so it gets no
    // script, no framing, and no caching of the code it displays.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
}


export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] as string);
}

/**
 * The page Cline lands on after the user approves. The gateway has already
 * exchanged the code and saved the connection by the time this renders, so the
 * page only reports the outcome and never shows a credential.
 *
 * It lives on the origin that also holds the local API keys, so it gets no
 * script, no framing, and nothing that could be reflected into the page.
 */

export function sendError(response: ServerResponse, error: unknown, trustedDashboardRequest = false) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = statusForError(error);
  if (status === 401 && !response.hasHeader('www-authenticate')) {
    response.setHeader('www-authenticate', 'Bearer realm="omnihilbras"');
  }
  sendJson(response, status, toErrorEnvelope(error, trustedDashboardRequest));
}

/**
 * `includeProviderMessage` is only ever true for an allowlisted local dashboard
 * origin. API clients get the provider-neutral message, while the dashboard also
 * gets what the provider actually said, which is the difference between a
 * diagnosable integration problem and a generic sentence.
 */

export function toErrorEnvelope(error: unknown, includeProviderMessage = false) {
  if (error instanceof ProviderError) {
    const details = error.details as { providerMessage?: string } | undefined;
    const providerMessage = includeProviderMessage && typeof details?.providerMessage === 'string' ? details.providerMessage : undefined;
    // Always present when the request carried an id, trusted caller or not: it is the gateway's own
    // identifier, contains nothing about the provider, and it is the one thing that lets a user
    // write down "it failed, 4f2a" and an operator find the line.
    const requestId = typeof (details as { requestId?: unknown } | undefined)?.requestId === 'string' ? (details as { requestId: string }).requestId : undefined;
    return {
      error: {
        code: error.code,
        message: error.publicMessage ?? publicProviderMessage(error.code),
        ...(requestId ? { requestId } : {}),
        ...(error.providerId ? { provider: error.providerId } : {}),
        ...(error.statusCode ? { status: error.statusCode } : {}),
        ...(error.retryable ? { retryable: true } : {}),
        ...(providerMessage ? { providerMessage } : {}),
      },
    };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'The gateway encountered an unexpected error.' } };
}


export function statusForError(error: unknown) {
  if (!(error instanceof ProviderError)) return 500;
  if (error.code === 'INVALID_REQUEST') return 400;
  if (error.code === 'AUTHENTICATION_FAILED') return 401;
  if (error.code === 'NOT_SUPPORTED') return 501;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'PROVIDER_TIMEOUT') return 504;
  if (error.code === 'CANCELLED') return 499;
  if (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_REQUEST_FAILED' || error.code === 'INVALID_RESPONSE') return 502;
  return 500;
}


export function invalidRequest(message: string) {
  return new ProviderError('INVALID_REQUEST', message, { publicMessage: message });
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


export function assertOnlyFields(body: Record<string, unknown>, allowed: string[]) {
  const allowedFields = new Set(allowed);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) throw invalidRequest('Request contains unsupported fields.');
}


export function parseIdentifier(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.trim())) throw invalidRequest(`${field} contains unsupported characters.`);
  return value.trim();
}


export function parseBoundedString(value: unknown, field: string, maxLength: number, allowEmpty = false) {
  if (typeof value !== 'string') throw invalidRequest(`${field} must be a string.`);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) throw invalidRequest(`${field} is invalid.`);
  return normalized;
}


export function parseBoundedInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}


export function readRequiredString(body: unknown, field: string): string {
  const value = readOptionalString(body, field);
  if (!value) throw invalidRequest(`${field} is required.`);
  return value;
}

/**
 * An optional string field.
 *
 * A non-string is treated as absent rather than coerced, so an object or an array sent
 * where a secret belongs cannot reach a provider as `"[object Object]"`.
 */

export function readOptionalString(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}


export function parseApiKey(body: unknown) {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (typeof body.apiKey !== 'string') throw invalidRequest('apiKey is required.');
  const apiKey = body.apiKey;
  if (!apiKey || apiKey !== apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw invalidRequest('apiKey must be a non-empty safe string.');
  return { type: 'api-key' as const, value: apiKey };
}


export function parsePriority(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) throw invalidRequest('priority must be an integer from 1 to 1000.');
  return value;
}


export function parseModelPolicy(value: unknown): ModelImportPolicy {
  if (value === undefined) return 'free';
  if (value !== 'free' && value !== 'all') throw invalidRequest('modelPolicy must be free or all.');
  return value;
}

/** A caller-supplied connection id, held to the same shape as a provider id. */

export function parseConnectionId(value: unknown) {
  if (typeof value !== 'string') throw invalidRequest('id must be a string.');
  return parseIdentifier(value, 'connection id');
}

