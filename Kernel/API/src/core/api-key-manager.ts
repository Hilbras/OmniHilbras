import { isProviderError } from './provider-error.js';
import { ProviderError } from './index.js';;
import { ApiKeyLimitError, type ApiKeyStore } from './api-keys.js';

/**
 * API keys, as their own concern.
 *
 * Extracted from `GatewayService` for the same reason health was: key management is a
 * self-contained policy with no knowledge of connections, routing, or models, and it was
 * reachable only by building a whole service around it.
 *
 * ## What this boundary is for
 *
 * The security properties live in the store — cryptographically random keys, SHA-256 hashing,
 * one-time secret reveal, constant-time comparison. This adds only the two things a store cannot
 * decide for itself:
 *
 * **Whether enforcement is even on.** A gateway with no key store is not a gateway that accepts
 * every key; it is an embedder or a test that has not configured one. Returning early when
 * enforcement is off keeps that distinction explicit rather than accidental.
 *
 * **A mutation is a unit.** Every write goes through one lock. A key created while another is being
 * removed is a lost update on a file-backed store, and the store has no way to know that two
 * operations were meant to be sequential.
 */

export type GatewayApiKeyList = {
  keys: Awaited<ReturnType<ApiKeyStore['list']>>;
  requireApiKey: boolean;
};

export type CreatedApiKey = Awaited<ReturnType<ApiKeyStore['create']>>;

const missingApiKeyMessage = 'This gateway requires an API key. Create one on the API keys page and send it as "Authorization: Bearer <key>".';
const invalidApiKeyMessage = 'The API key is invalid or paused.';

/** Serialises writes, so two concurrent mutations cannot interleave on a file-backed store. */
class MutationLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    // The chain must survive a rejection, or one failed mutation wedges every later one.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * The two user-facing strings, moved verbatim.
 *
 * I rewrote both while extracting and a test caught it. A message is part of the product's
 * surface, and a refactor that quietly rewords what a user reads is a behaviour change wearing a
 * refactor's clothes — which is the one thing this phase is explicitly not supposed to do.
 */
export class ApiKeyManager {
  /** One sliding minute per key id. See `enforceLimits` for what it does and does not guarantee. */
  private readonly rateWindow = new Map<string, number[]>();
  private readonly lock = new MutationLock();

  constructor(private readonly store?: ApiKeyStore) {}

  private requireStore(): ApiKeyStore {
    if (!this.store) {
      throw new ProviderError('CONFIGURATION_ERROR', 'API key storage is not configured on this gateway.');
    }
    return this.store;
  }

  async list(): Promise<GatewayApiKeyList> {
    if (!this.store) return { keys: [], requireApiKey: false };
    const [keys, requireApiKey] = await Promise.all([this.store.list(), this.store.isEnforced()]);
    return { keys, requireApiKey };
  }

  /**
   * One write, with the store's own failures mapped to codes routing can act on.
   *
   * The mapping is the point. A file-backed store throws plain `Error`s — a limit reached, a
   * directory that is not writable — and an unmapped `Error` reaching the HTTP layer becomes an
   * opaque 500 that tells the user nothing about which of those happened. A limit is the caller's
   * fault and retryable by changing the request; anything else is not.
   */
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      try {
        return await operation();
      } catch (error) {
        if (isProviderError(error)) throw error;
        // The limit is the caller's own input problem, so its reason travels: the generic replacement
        // ("The request is invalid.") is what a person got for a full key list, with nothing to act on.
        if (error instanceof ApiKeyLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error, publicMessage: error.message });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local API key store could not be updated.', { cause: error });
      }
    });
  }

  create(name: string, workspaceId?: string) {
    // The secret is returned exactly once, here, and never re-readable. Anything that wanted to
    // show it twice would have to store it, which is the thing this design avoids.
    return this.mutate(() => this.requireStore().create(name, workspaceId));
  }

  async setEnabled(id: string, enabled: boolean) {
    return this.mutate(async () => {
      const record = await this.requireStore().setEnabled(id, enabled);
      if (!record) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
      return record;
    });
  }

  /**
   * Renames a key.
   *
   * A rename is not a rotation: the secret, its hash and its prefix stay exactly as they were, so a client that is
   * already using the key keeps working. The name is what a person sees, and this is the only field of a key that
   * can be changed without invalidating it.
   */
  async rename(id: string, name: string) {
    return this.mutate(async () => {
      const record = await this.requireStore().rename(id, name);
      if (!record) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
      return record;
    });
  }

  async remove(id: string) {
    return this.mutate(async () => {
      const removed = await this.requireStore().remove(id);
      if (!removed) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
    });
  }

  setEnforced(value: boolean) {
    return this.mutate(() => this.requireStore().setEnforced(value));
  }

  /**
   * Guards the public LLM surface.
   *
   * Callers that are already-trusted local administration surfaces — the dashboard — must not call
   * this. It exists for embedders and unit tests that construct a gateway without key storage,
   * where the absence of a store means "not configured" rather than "accept anything".
   *
   * The two limits are enforced **here**, at the gate, rather than further in: a key that may not use the gateway
   * should not reach routing, and the refusal must be the same whichever endpoint it was aimed at.
   */
  async authorize(presentedKey: string | undefined) {
    if (!this.store || !(await this.store.isEnforced())) return;
    if (!presentedKey) throw new ProviderError('AUTHENTICATION_FAILED', missingApiKeyMessage, { publicMessage: missingApiKeyMessage });
    const record = await this.store.authenticate(presentedKey);
    if (!record) {
      throw new ProviderError('AUTHENTICATION_FAILED', invalidApiKeyMessage, { publicMessage: invalidApiKeyMessage });
    }
    this.enforceLimits(record);
  }

  /**
   * Whether this key may still be used, and whether it may be used *now*.
   *
   * Expiry is absolute: a key past its date is refused with `AUTHENTICATION_FAILED` and a message that says so,
   * because the fix is a new key, not a retry. The rate limit is `RATE_LIMITED`, because that one *is* a retry.
   *
   * The counter is a sliding minute held in memory, and its limits are stated rather than implied: it is exact per
   * process and resets on restart. A durable counter would put a disk write on the authentication path of every
   * request to enforce a limit measured in minutes, which is a worse trade than a burst after a restart.
   */
  private enforceLimits(record: Awaited<ReturnType<ApiKeyStore['authenticate']>> & object) {
    if (record.expiresAt !== undefined) {
      const expires = Date.parse(record.expiresAt);
      if (Number.isFinite(expires) && expires <= Date.now()) {
        const message = `This API key expired on ${new Date(expires).toISOString()}. Create another one.`;
        throw new ProviderError('AUTHENTICATION_FAILED', message, { publicMessage: message });
      }
    }
    if (typeof record.rpm !== 'number' || record.rpm <= 0) return;
    const now = Date.now();
    const window = this.rateWindow.get(record.id) ?? [];
    // Keep only the last minute, which is what "per minute" means; the array stays small because it is pruned here.
    const recent = window.filter((at) => now - at < 60_000);
    if (recent.length >= record.rpm) {
      this.rateWindow.set(record.id, recent);
      const message = `This API key is limited to ${record.rpm} requests a minute. Try again shortly.`;
      throw new ProviderError('RATE_LIMITED', message, { publicMessage: message, retryable: true });
    }
    recent.push(now);
    this.rateWindow.set(record.id, recent);
  }

  /** Sets or clears a key's limits. `null` clears a field; omitting it leaves that field alone. */
  async setLimits(id: string, limits: { rpm?: number | null; expiresAt?: string | null }) {
    return this.mutate(async () => {
      const record = await this.requireStore().setLimits(id, limits);
      if (!record) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
      return record;
    });
  }
}
