import { ProviderError } from './errors.js';

export function normalizeProviderBaseUrl(value: string, providerId: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('URL userinfo is not allowed');
    if (url.search || url.hash) throw new Error('URL query and fragment are not allowed');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
      throw new Error('Remote provider URLs must use HTTPS');
    }
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new ProviderError('CONFIGURATION_ERROR', `Invalid base URL for provider ${providerId}.`, { providerId, cause: error });
  }
}

export function resolveProviderUrl(baseUrl: string, path: string, providerId: string) {
  const normalizedPath = path.trim();
  if (!normalizedPath || /^[a-z][a-z\d+.-]*:/i.test(normalizedPath) || normalizedPath.startsWith('//') || normalizedPath.includes('\\')) {
    throw new ProviderError('CONFIGURATION_ERROR', `Invalid provider path for ${providerId}.`, { providerId });
  }

  const base = new URL(`${baseUrl}/`);
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

export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized === '0:0:0:0:0:0:0:1';
}
