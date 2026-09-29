import { ProviderError } from '@hilbras/omnihilbras';
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
        if (error instanceof ProviderError) throw error;
        if (error instanceof ApiKeyLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local API key store could not be updated.', { cause: error });
      }
    });
  }

  create(name: string) {
    // The secret is returned exactly once, here, and never re-readable. Anything that wanted to
    // show it twice would have to store it, which is the thing this design avoids.
    return this.mutate(() => this.requireStore().create(name));
  }

  async setEnabled(id: string, enabled: boolean) {
    return this.mutate(async () => {
      const record = await this.requireStore().setEnabled(id, enabled);
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
   */
  async authorize(presentedKey: string | undefined) {
    if (!this.store || !(await this.store.isEnforced())) return;
    if (!presentedKey) throw new ProviderError('AUTHENTICATION_FAILED', missingApiKeyMessage, { publicMessage: missingApiKeyMessage });
    if (!(await this.store.authenticate(presentedKey))) {
      throw new ProviderError('AUTHENTICATION_FAILED', invalidApiKeyMessage, { publicMessage: invalidApiKeyMessage });
    }
  }
}
