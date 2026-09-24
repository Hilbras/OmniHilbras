import { ProviderError } from './errors.js';

export function normalizeProviderBaseUrl(value: string, providerId: string) {
  try {
    const url = new URL(value);
    if (url.search || url.hash) throw new Error('URL query and fragment are not allowed');
    assertSafeProviderRequestUrl(url.toString(), providerId);
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new ProviderError('CONFIGURATION_ERROR', `Invalid base URL for provider ${providerId}.`, { providerId, cause: error });
  }
}

export function assertSafeProviderRequestUrl(value: string, providerId: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('URL userinfo is not allowed');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
      throw new Error('Remote provider URLs must use HTTPS');
    }
    if (url.protocol === 'https:' && isPrivateHostname(url.hostname)) throw new Error('Private provider destinations are not allowed.');
    return url.toString();
  } catch (error) {
    throw new ProviderError('CONFIGURATION_ERROR', `Invalid provider URL for ${providerId}.`, { providerId, cause: error });
  }
}

export function resolveProviderUrl(baseUrl: string, path: string, providerId: string) {
  const normalizedPath = path.trim();
  if (!normalizedPath || /^[a-z][a-z\d+.-]*:/i.test(normalizedPath) || normalizedPath.startsWith('//') || normalizedPath.includes('\\')) {
    throw new ProviderError('CONFIGURATION_ERROR', `Invalid provider path for ${providerId}.`, { providerId });
  }

  assertSafeProviderRequestUrl(baseUrl, providerId);
  const base = new URL(`${baseUrl}/`);
  if (base.search || base.hash) throw new ProviderError('CONFIGURATION_ERROR', `Provider base URL cannot contain a query or fragment for ${providerId}.`, { providerId });
  const resolved = new URL(normalizedPath.replace(/^\/+/, ''), base);
  const basePath = base.pathname.replace(/\/$/, '');
  if (resolved.origin !== base.origin || (basePath && resolved.pathname !== basePath && !resolved.pathname.startsWith(`${basePath}/`))) {
    throw new ProviderError('CONFIGURATION_ERROR', `Provider path escaped the configured base URL for ${providerId}.`, { providerId });
  }
  return resolved.toString();
}

const credentialHeaderNames = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-goog-api-key']);
const transportHeaderNames = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export function assertSafeProviderHeaderName(name: string, providerId: string, options: { allowCredential?: boolean } = {}) {
  const normalized = name.toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/i.test(name) || transportHeaderNames.has(normalized) || (!options.allowCredential && credentialHeaderNames.has(normalized))) {
    throw new ProviderError('CONFIGURATION_ERROR', `Header ${name} is not allowed for provider ${providerId}.`, { providerId });
  }
}

export function assertSafeProviderHeaderValue(name: string, value: string, providerId: string) {
  if (/[\r\n\0]/.test(value)) {
    throw new ProviderError('CONFIGURATION_ERROR', `Header ${name} contains an unsafe value for provider ${providerId}.`, { providerId });
  }
}

export function sanitizeProviderHeaders(headers: Record<string, string> | undefined, providerId: string) {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    assertSafeProviderHeaderName(name, providerId);
    assertSafeProviderHeaderValue(name, value, providerId);
    safe[name] = value;
  }
  return safe;
}

export function isPrivateHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.local') || normalized.endsWith('.internal')) return true;
  if (isStrictIpv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    return first === 0 || first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127);
  }
  if (!normalized.includes(':')) return false;
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  if (isStrictIpv4(normalized)) return normalized.split('.')[0] === '127';
  return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1';
}

export function canonicalLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return '127.0.0.1';
  if (isStrictIpv4(normalized) && normalized.split('.')[0] === '127') return normalized;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return '::1';
  throw new Error('Host must be a loopback address.');
}

function isStrictIpv4(value: string) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}
