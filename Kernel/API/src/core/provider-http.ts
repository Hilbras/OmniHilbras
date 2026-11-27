import { lookup, type LookupAddress } from 'node:dns';
import { Agent as HttpAgent, request as httpRequest, type Agent, type ClientRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createUnzip } from 'node:zlib';
import { cachedDestinationAddresses, destinationCacheTtlMs } from './destination-check.js';
import type { FetchLike } from './transport.js';

/**
 * The connection pool every provider request goes through.
 *
 * ## The measurement this exists for
 *
 * Node's global `fetch` is undici with a **4-second** keep-alive default. Measured against a local TLS
 * listener on 2026-11-27, four requests spaced 5.5 s apart opened **four connections**; the same four
 * requests through a keep-alive agent opened **one**. A handshake that costs 10 ms on loopback costs
 * 100–300 ms across an ocean, and a provider conversation is exactly this shape — a turn, a tool call,
 * the next turn — with gaps longer than four seconds between them. So every turn after the first paid
 * a fresh TCP + TLS handshake, and undici's connector paid a second DNS lookup besides: the gateway's
 * destination check had already resolved and cached the name, and then the connection resolved it again.
 *
 * This module owns the connection instead:
 *
 * - **One agent per protocol, shared by every adapter and every transport.** A chat turn and the health
 *   sweep for the same provider reuse the same socket, because the pool is keyed by origin rather than
 *   by the adapter that asked.
 * - **A 90-second idle window**, so an agent loop that pauses to think, run a tool, or wait for a user
 *   does not hand the handshake back. Free sockets are destroyed after the window, and the window is
 *   refreshed each time a socket is returned, so the pool cannot grow without bound either.
 * - **The address the destination check judged is the address connected to.** The check's answer is
 *   cached with its verdict, and the connector uses it instead of resolving again. That removes the
 *   duplicate lookup *and* narrows the DNS-rebinding gap `destination-check.ts` documented: the
 *   connection no longer asks a resolver a second time and hopes for the same answer.
 * - **Compression is decoded here.** Node's raw `http` module does not decompress, while `fetch` did, so
 *   this layer advertises and decodes gzip, deflate and brotli and strips the headers — the adapter sees
 *   the same bytes it saw before.
 *
 * `OMNIHILBRAS_PROVIDER_POOL=off` restores the global fetch for one process, which is the escape hatch
 * for a network that rejects keep-alive or an operator comparing the two.
 */

const DEFAULT_KEEPALIVE_MS = 90_000;
const DEFAULT_MAX_SOCKETS = 64;
const DEFAULT_MAX_FREE_SOCKETS = 16;
const MAX_CACHED_ADDRESSES = 256;

type Address = { address: string; family: number };

type LookupOptions = {
  family?: number | string;
  hints?: number;
  all?: boolean;
  verbatim?: boolean;
};

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** What a caller can observe about the pool. Counts are process-lifetime, and nothing is reset by a request. */
export type ProviderHttpStats = {
  /** Requests handed to this pool. */
  requests: number;
  /** Requests that opened a new TCP connection. */
  connections: number;
  /** Requests that reused a pooled connection. This is the number the release is about. */
  reused: number;
};

export type ProviderHttpOptions = {
  keepAliveMs?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
  maxCachedSessions?: number;
  /** Test seam: resolve a name without the system resolver. */
  resolve?: (hostname: string) => Promise<Address[]>;
  /** Test seam: the destination check's cached answer, when the caller does not want the real one. */
  addressesFor?: (hostname: string) => string[] | undefined;
  /** How long a resolved answer is reused. Defaults to the destination check's TTL. */
  addressTtlMs?: number;
  /** Used when a request cannot be represented here and has to fall back. */
  fallback?: FetchLike;
};

/** A free socket is destroyed after this long, and the timer is replaced when it is next returned. */
const idleTimers = new WeakMap<Socket, NodeJS.Timeout>();

/**
 * The pool itself, instantiable so a test can count connections and inject a resolver.
 *
 * The class is deliberately small: it is a connector, not a second transport. Timeouts, byte bounds,
 * streaming and error classification stay in `FetchHttpTransport`; this only turns a request into a
 * socket and a `Response`.
 */
export class ProviderHttpPool {
  readonly stats: ProviderHttpStats = { requests: 0, connections: 0, reused: 0 };
  readonly fetch: FetchLike;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;
  private readonly keepAliveMs: number;
  private readonly addressTtlMs: number;
  private readonly addresses = new Map<string, { list: Address[]; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Address[]>>();
  private readonly resolveName: (hostname: string) => Promise<Address[]>;
  private readonly addressesFor: (hostname: string) => string[] | undefined;
  private readonly fallback: FetchLike;

  constructor(options: ProviderHttpOptions = {}) {
    this.keepAliveMs = Math.max(0, options.keepAliveMs ?? positiveEnv('OMNIHILBRAS_PROVIDER_KEEPALIVE_MS', DEFAULT_KEEPALIVE_MS));
    const maxSockets = Math.max(1, options.maxSockets ?? positiveEnv('OMNIHILBRAS_PROVIDER_MAX_SOCKETS', DEFAULT_MAX_SOCKETS));
    const maxFreeSockets = Math.max(0, options.maxFreeSockets ?? Math.min(DEFAULT_MAX_FREE_SOCKETS, maxSockets));
    const agentOptions = { keepAlive: true, maxSockets, maxFreeSockets, scheduling: 'lifo' as const };
    this.httpAgent = new HttpAgent(agentOptions);
    this.httpsAgent = new HttpsAgent({ ...agentOptions, maxCachedSessions: options.maxCachedSessions ?? 100 });
    this.attachIdleEviction(this.httpAgent);
    this.attachIdleEviction(this.httpsAgent);
    this.addressTtlMs = options.addressTtlMs ?? destinationCacheTtlMs();
    this.resolveName = options.resolve ?? ((hostname) => resolveWithSystem(hostname));
    this.addressesFor = options.addressesFor ?? cachedDestinationAddresses;
    this.fallback = options.fallback ?? ((input, init) => globalThis.fetch(input, init));
    this.fetch = async (input, init) => this.dispatch(input, init);
  }

  close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private attachIdleEviction(agent: Agent): void {
    if (this.keepAliveMs <= 0) return;
    agent.on('free', (socket: Socket) => {
      const previous = idleTimers.get(socket);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        idleTimers.delete(socket);
        // The socket may have been handed to a new request since it was freed; destroying it then
        // would abort a live response. Membership in the free list is the proof that it is idle.
        if (isFreeSocket(agent, socket)) socket.destroy();
      }, this.keepAliveMs);
      timer.unref?.();
      idleTimers.set(socket, timer);
      socket.once('close', () => {
        const pendingTimer = idleTimers.get(socket);
        if (pendingTimer) clearTimeout(pendingTimer);
        idleTimers.delete(socket);
      });
    });
  }

  private async dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : undefined;
    // A `Request` object or a body this layer does not encode is delegated rather than guessed at.
    // Every call site in the gateway passes a string URL, a string body and `redirect: 'error'`, so the
    // fallback is a correctness net, not the common path.
    if (!url) return this.fallback(input, init);
    if (init?.redirect !== 'error') return this.fallback(input, init);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return this.fallback(input, init);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return this.fallback(input, init);
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      return this.fallback(input, init);
    }

    const method = (init.method ?? 'GET').toUpperCase();
    const headers = headerRecord(init.headers);
    if (!hasHeader(headers, 'accept-encoding')) headers['accept-encoding'] = 'gzip, deflate, br';
    const agent = target.protocol === 'https:' ? this.httpsAgent : this.httpAgent;
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    this.stats.requests += 1;

    return new Promise<Response>((resolve, reject) => {
      let accepted = false;
      const fail = (error: unknown) => {
        if (!accepted) reject(asTransportError(error));
      };

      const outgoing: ClientRequest = request(target, {
        method,
        headers,
        agent,
        // `autoSelectFamily` is on by default from Node 20, and it asks `lookup` for every address so
        // it can race IPv6 and IPv4. This connector answers that call with the checked address list.
        lookup: this.lookup,
      }, (incoming: IncomingMessage) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400 && status !== 304) {
          incoming.resume();
          outgoing.destroy();
          fail(redirectError(target));
          return;
        }
        accepted = true;
        resolve(this.toResponse(incoming, method));
      });

      outgoing.on('socket', (socket: Socket) => {
        if (socket.connecting) this.stats.connections += 1;
        else this.stats.reused += 1;
      });
      outgoing.on('error', (error) => fail(error));

      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          outgoing.destroy(abortError(signal));
        } else {
          signal.addEventListener('abort', () => outgoing.destroy(abortError(signal)), { once: true });
        }
      }
      outgoing.end(body ?? undefined);
    });
  }

  private toResponse(incoming: IncomingMessage, method: string): Response {
    const status = incoming.statusCode ?? 502;
    const encoding = incoming.headers['content-encoding'];
    const decoded = decodedBody(incoming, encoding);
    const headers = responseHeaders(incoming.headers, decoded !== incoming);
    const bodyless = status === 204 || status === 205 || status === 304 || method === 'HEAD';
    if (bodyless) {
      // `Response` refuses a body on these statuses, and a caller would never read one.
      incoming.resume();
      return new Response(null, { status, statusText: incoming.statusMessage ?? '', headers });
    }
    const stream = Readable.toWeb(decoded) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, { status, statusText: incoming.statusMessage ?? '', headers });
  }

  /**
   * The connector's `lookup`.
   *
   * The destination check runs before every remote request and keeps the addresses it judged. Asking
   * that cache first means one resolve serves both the security check and the connection, and the
   * address the check approved is the address dialled. When the check is absent (an embedder or a
   * test), this resolves once and caches for the same TTL.
   */
  private lookup = (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    this.addressesForCached(hostname).then((list) => {
      const family = familyOf(options.family);
      const usable = family === 0 ? list : list.filter((entry) => entry.family === family);
      if (usable.length === 0) {
        const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
        callback(error, '', 0);
        return;
      }
      if (options.all) callback(null, usable as LookupAddress[]);
      else callback(null, usable[0]!.address, usable[0]!.family);
    }, (error: NodeJS.ErrnoException) => callback(error, '', 0));
  };

  private addressesForCached(hostname: string): Promise<Address[]> {
    const approved = this.addressesFor(hostname);
    if (approved && approved.length > 0) return Promise.resolve(toAddresses(approved));
    const cached = this.addresses.get(hostname);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.list);
    const inFlight = this.pending.get(hostname);
    if (inFlight) return inFlight;
    const work = this.resolveName(hostname).then((list) => {
      if (list.length === 0) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
      if (this.addressTtlMs > 0) {
        if (this.addresses.size >= MAX_CACHED_ADDRESSES) {
          const oldest = this.addresses.keys().next();
          if (!oldest.done) this.addresses.delete(oldest.value);
        }
        this.addresses.set(hostname, { list, expiresAt: Date.now() + this.addressTtlMs });
      }
      return list;
    }).finally(() => { this.pending.delete(hostname); });
    this.pending.set(hostname, work);
    return work;
  }
}

function toAddresses(values: string[]): Address[] {
  return values.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

function resolveWithSystem(hostname: string): Promise<Address[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => ({ address: entry.address, family: entry.family })));
    });
  });
}

function familyOf(family: LookupOptions['family']): number {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return 0;
}

function isFreeSocket(agent: Agent, socket: Socket): boolean {
  const pools = agent.freeSockets as Record<string, Socket[] | undefined>;
  for (const pool of Object.values(pools)) {
    if (pool?.includes(socket)) return true;
  }
  return false;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function decodedBody(incoming: IncomingMessage, encoding: string | undefined): Readable {
  const value = (encoding ?? '').trim().toLowerCase();
  if (!value || value === 'identity') return incoming;
  if (value === 'gzip' || value === 'x-gzip') return incoming.pipe(createGunzip());
  if (value === 'deflate') return incoming.pipe(createUnzip());
  if (value === 'br') return incoming.pipe(createBrotliDecompress());
  // An encoding this layer does not know is left alone, including its header, so the caller sees the
  // same bytes it would have seen from global fetch rather than a silently truncated body. Only the
  // encodings advertised above are expected; zstd is deliberately not advertised because it arrived in
  // Node after the oldest version this gateway supports.
  return incoming;
}

function responseHeaders(source: IncomingMessage['headers'], decoded: boolean): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (name === 'transfer-encoding' || name === 'connection' || name === 'keep-alive') continue;
    if (decoded && (name === 'content-encoding' || name === 'content-length')) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Keep the transport's error vocabulary.
 *
 * An `AbortError` has to stay an `Error` named `AbortError`: `normalizeTransportError` checks the name,
 * and a raw `DOMException` is not an `Error` in Node, so it would be classified as an unreachable
 * provider instead of a cancellation.
 */
function asTransportError(error: unknown): unknown {
  if (error instanceof Error) return error;
  if (typeof DOMException === 'function' && error instanceof DOMException) {
    const wrapped = new Error(error.message);
    wrapped.name = error.name;
    return wrapped;
  }
  return error;
}

function redirectError(target: URL): Error {
  const error = new TypeError(`fetch failed: unexpected redirect from ${target.origin}`);
  (error as TypeError & { cause?: unknown }).cause = { code: 'ERR_REDIRECT', url: target.toString() };
  return error;
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The process-wide pool. One agent pair, shared by every transport and every adapter. */
let defaultPool: ProviderHttpPool | undefined;

export function providerHttpPool(): ProviderHttpPool {
  defaultPool ??= new ProviderHttpPool();
  return defaultPool;
}

export const providerHttpFetch: FetchLike = (input, init) => providerHttpPool().fetch(input, init);

export function providerHttpStats(): ProviderHttpStats {
  return { ...providerHttpPool().stats };
}

/** Test-only teardown; a second call repopulates the default pool on demand. */
export function closeProviderHttpPool(): void {
  defaultPool?.close();
  defaultPool = undefined;
}

/** Whether the operator disabled the pool; the transport then keeps the previous global-fetch behavior. */
export function providerPoolEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env.OMNIHILBRAS_PROVIDER_POOL?.trim().toLowerCase();
  return value !== 'off' && value !== '0' && value !== 'false';
}

export function providerHttpFetchFor(env: Readonly<Record<string, string | undefined>> = process.env): FetchLike {
  return providerPoolEnabled(env) ? providerHttpFetch : (input, init) => globalThis.fetch(input, init);
}
