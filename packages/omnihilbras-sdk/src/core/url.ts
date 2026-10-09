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
  // An IPv4-mapped or -compatible IPv6 address is an IPv4 address wearing a hat: `::ffff:169.254.169.254`
  // reaches the same host as `169.254.169.254`, and the prefix checks below cannot see that. Without this,
  // the cloud metadata endpoint is reachable as `https://[::ffff:169.254.169.254]/` while the plain form
  // is correctly refused — verified against a live listener, which received the connection. Unwrap the
  // embedded IPv4 first and judge it by the same rules as a bare IPv4 literal.
  const embedded = embeddedIpv4InIpv6(normalized);
  if (embedded) return isPrivateHostname(embedded);
  // The unspecified address `::` is the IPv6 counterpart of `0.0.0.0`, and `0.0.0.0` is treated as private
  // above. `::` did not match any of the prefixes below and was allowed.
  if (isUnspecifiedIpv6(normalized)) return true;
  if (isStrictIpv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    return first === 0 || first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127);
  }
  if (!normalized.includes(':')) return false;
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

/**
 * The IPv4 literal embedded in an IPv6 address, or `undefined` if there is not a parsable one.
 *
 * ## Why the hex form is the one that matters
 *
 * `new URL('https://[::ffff:169.254.169.254]/').hostname` is `[::ffff:a9fe:a9fe]` — the WHATWG parser
 * normalizes the dotted quad to hex **before** this function ever sees it. So a match on a trailing dotted
 * quad would be dead code, and the fully written-out spelling is not an edge case: it is the only form that
 * arrives. (Both of the first two test cases below produce the same normalised hostname, which is what
 * exposed it.)
 *
 * IPv4-mapped and IPv4-compatible addresses have groups 6 and 7 as the 32-bit address, so the value is
 * expanded to eight 16-bit groups and those two are read as bytes. A pattern match on a `a9fe:a9fe` suffix
 * would have been simpler and would not have worked.
 */
function embeddedIpv4InIpv6(value: string) {
  if (!value.includes(':')) return undefined;
  const withoutZone = value.split('%')[0] ?? '';
  // Expand `::` to the right number of zero groups, so the last two are always groups 6 and 7.
  const [head = '', tail = ''] = withoutZone.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const written = headGroups.length + tailGroups.length;
  if (written > 8) return undefined;
  const missing = 8 - written;
  const groups = withoutZone.includes('::') ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups] : headGroups;
  if (groups.length !== 8) return undefined;
  const numbers = groups.map((group) => Number.parseInt(group, 16));
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return undefined;
  // Groups 6 and 7 are the embedded 32-bit address; group 5 is the `ffff` of an IPv4-mapped address.
  const high = numbers[6] ?? 0;
  const low = numbers[7] ?? 0;
  const marker = numbers[5] ?? 0;
  // IPv4-mapped is `::ffff:a.b.c.d`, so group 5 is 0xffff. IPv4-compatible is `::a.b.c.d`, which is all
  // zeros in groups 0–5 — a deprecated form, but `::0.0.0.1`-style input still normalises to it and must
  // not be read as a routable IPv6 address.
  //
  // Reading the `ffff` out of group 6 instead of group 5 is what made the first version of this return
  // undefined for the exact input it existed to catch: `a9fe` is not `ffff`. The guard then fell through to
  // the prefix checks, none of which matched, and the metadata endpoint stayed reachable. The
  // `fe80::1` case is the same class of trap from the other side — it also ends in 0x0001, and treating it
  // as `0.0.0.1` gives the right verdict for the wrong reason.
  const isMapped = marker === 0xffff;
  const isCompatible = numbers.slice(0, 6).every((n) => n === 0);
  if (!isMapped && !isCompatible) return undefined;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * `::`, and its expanded spelling `0:0:0:0:0:0:0:0` — the IPv6 counterpart of `0.0.0.0`.
 *
 * Requires at least one `::` or a colon, so a bare host name is never treated as an address, and expands
 * before testing so a shortened form like `0::` is caught too. It runs *after* the embedded-IPv4 unwrap
 * because `::` also satisfies "all groups zero", and reporting it as `0.0.0.0` is a true answer reached by
 * a route that would be wrong for any other all-zero-looking address.
 */
function isUnspecifiedIpv6(value: string) {
  if (!value.includes(':')) return false;
  const [head = '', tail = ''] = value.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  if (headGroups.length + tailGroups.length > 8) return false;
  return [...headGroups, ...tailGroups].every((group) => Number.parseInt(group, 16) === 0);
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
