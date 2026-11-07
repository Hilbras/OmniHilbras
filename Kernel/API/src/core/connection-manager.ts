import { isProviderError } from './provider-error.js';
import { ProviderError, type Model, type ModelImportPolicy, type ProviderCredential } from './index.js';;
import { ConnectionMetadataLimitError, ConnectionModelLimitError, modelMetaPriceOrder, type ConnectionInput, type ConnectionRecord, type ConnectionStore, type ModelMeta, type ModelMetaMap, type ResilienceSettings } from './connections.js';

/**
 * Storing and changing connections.
 *
 * Extracted from `GatewayService`, which held six methods with the same shape and four near-copies
 * of the same error mapping. The duplication was the part worth fixing rather than just moving:
 *
 * ```ts
 * try { …store call… ; if (!result) throw new ProviderError('NOT_FOUND', …); }
 * catch (error) {
 *   if (isProviderError(error)) throw error;
 *   if (error instanceof ConnectionModelLimitError || error instanceof ConnectionMetadataLimitError)
 *     throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
 *   throw new ProviderError('CONFIGURATION_ERROR', '…', { cause: error });
 * }
 * ```
 *
 * The only real difference between the copies was the final sentence — *which* thing could not be
 * saved. Four near-identical error mappers is four places for the next one to drift, and the one
 * that drifts is the one that starts blaming the operator for a disk error. There is now one
 * mapper and it takes the one sentence that varies.
 *
 * ## The two rules this file exists to state once
 *
 * **A store failure is never a provider failure.** A limit error is the operator's input being too
 * large, so it is `INVALID_REQUEST` and the store's own wording is kept. Anything else is ours, so
 * it is `CONFIGURATION_ERROR` and it names what could not be saved.
 *
 * **A custom model survives a rescan, and a withdrawn one does not.** The provider is the authority
 * on what it serves, so discovered ids are *replaced* rather than unioned — a union would keep a
 * withdrawn model forever and file it as a custom addition besides, leaving the operator no way to
 * tell which models the provider chose to withdraw. Custom ids are the operator's own and are
 * never touched.
 *
 * ## Locking is not uniform, and that is deliberate
 *
 * `save` holds the mutation lock across *everything* — prove the credential, read the catalog, then
 * store — because two concurrent saves of one connection would otherwise interleave a catalog read
 * between a validation and a write. The narrower operations hold it only around their store call.
 * `refreshModels` deliberately holds **no** lock: it is a long catalog read, and making every save
 * queue behind a slow provider would turn a background rescan into a stall on the dashboard's
 * save button. That asymmetry was in the original and is preserved exactly; the tests below pin it.
 *
 * ## What stayed behind
 *
 * Everything provider-facing. Reading a catalog and proving a credential both need the registry and
 * the resolver, and both are the service's business. This file asks for them through injected
 * operations rather than reaching for them.
 */

/**
 * Indexes discovered models the way the store records them.
 *
 * Moved verbatim. The `ModelMeta` fields are single letters — `n`, `c`, `i`, `o`, `p` — because
 * this is written to the store once per model per rescan and read on every model list, and the
 * abbreviations are what keeps a thousand-model catalog small. Re-deriving this function from its
 * shape rather than moving it would have silently changed the stored format.
 */
export function modelMetaFor(models: readonly Model[]): ModelMetaMap | undefined {
  const meta: ModelMetaMap = {};
  for (const model of models) {
    const prices = modelMetaPriceOrder
      .map((key) => model.pricing?.[key])
      .filter((value): value is number => typeof value === 'number');
    const entry: ModelMeta = {
      ...(model.displayName ? { n: model.displayName } : {}),
      ...(model.contextWindow ? { c: model.contextWindow } : {}),
      ...(model.inputModalities?.length ? { i: [...model.inputModalities] } : {}),
      ...(model.outputModalities?.length ? { o: [...model.outputModalities] } : {}),
      ...(prices.length ? { p: prices } : {}),
    };
    if (Object.keys(entry).length > 0) meta[model.id] = entry;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * What the manager needs from the service, as named operations.
 *
 * The two provider-facing ones are here because storing a connection and proving it are a single
 * user action: a credential the provider will not accept must not reach the store.
 */
export type ConnectionManagerDeps = {
  /** Serialises mutations so two saves of one connection cannot interleave. */
  lock: <T>(operation: () => Promise<T>) => Promise<T>;
  /**
   * Proves a credential before it is stored, whether the provider is registered or built on demand.
   * Throws if the provider will not accept it.
   */
  validate: (providerId: string, credential: ProviderCredential, signal?: AbortSignal) => Promise<void>;
  /** Whether the provider can be probed at all. One without a validator is stored unchecked. */
  canValidate: (providerId: string) => boolean;
  /** Asks the provider what it serves. */
  discover: (input: { providerId: string; credential: ProviderCredential; policy: ModelImportPolicy; signal?: AbortSignal; pendingEndpoint?: { endpoint: string; name: string } }) => Promise<readonly Model[]>;
  readCredential: (connectionId: string, providerId: string) => Promise<ProviderCredential | undefined>;
  /**
   * Records that a catalog could not be read, for the dashboard to show.
   *
   * Takes the error rather than a string so the wording stays where it already lives — the service
   * knows how to ask a provider what it actually said, and a note reduced to `error.message` here
   * would throw away the provider's own explanation.
   */
  noteDiscoveryFailure: (error: unknown) => void;
  /** The vault-local fingerprint of a credential, so a saved account is recognised on the next save. */
  credentialFingerprint: (providerId: string, credential: ProviderCredential) => Promise<string>;
  /** The provider whose stored connection a card reads (`clinepass` → `cline`), or the id itself. */
  canonicalProviderId: (providerId: string) => string;
};

export class ConnectionManager {
  constructor(
    private readonly store: ConnectionStore | undefined,
    private readonly deps: ConnectionManagerDeps,
  ) {}

  /**
   * The store, or a named failure.
   *
   * Six methods used to open with this same two-line check, and each had to remember it. A missing
   * store is something an embedder causes, not a user error, so it is named as configuration.
   */
  private require(): ConnectionStore {
    if (!this.store) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.store;
  }

  /**
   * The one error mapper. `whatFailed` is the whole of what varies between callers.
   *
   * An error that is already a `ProviderError` passes through untouched, so a limit thrown by the
   * store keeps its own classification and a not-found thrown deeper down keeps its message.
   */
  private async storeCall<T>(whatFailed: string, operation: (store: ConnectionStore) => Promise<T>): Promise<T> {
    const store = this.require();
    try {
      return await operation(store);
    } catch (error) {
      if (isProviderError(error)) throw error;
      // A limit is the operator's input being too large, not a fault, and the store's own wording
      // is more specific than anything written here.
      if (error instanceof ConnectionModelLimitError || error instanceof ConnectionMetadataLimitError) {
        throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
      }
      // Anything else is ours. It names what could not be saved rather than blaming a provider that
      // was never asked.
      throw new ProviderError('CONFIGURATION_ERROR', `${whatFailed} could not be saved.`, { cause: error });
    }
  }

  /** Every stored connection, or none. An absent store is not an error for a list. */
  async list(): Promise<ConnectionRecord[]> {
    return this.store?.list() ?? [];
  }

  /** The first connection for a provider that actually holds a credential. */
  async firstWithCredentialFor(providerId: string): Promise<ConnectionRecord | undefined> {
    // A record that shares its credential names the extra providers in `providers` — ClinePass reads the
    // connection signed in as Cline. Matching only `providerId` left every shared provider with no
    // credential at all, which surfaced as "no-models" at routing time and an empty page at read time.
    const matches = (await this.list()).filter(
      (connection) => (connection.providerId === providerId || connection.providers?.includes(providerId)) && connection.hasCredential,
    );
    return matches[0];
  }

  /**
   * Stores a connection, after proving its credential.
   *
   * The order is the point: a credential the provider will not accept must never reach the store,
   * because a connection that exists but cannot be used reads in the dashboard as working and fails
   * on its first request.
   */
  /**
   * Saves a connection, recognising a credential that is already saved.
   *
   * ## Why this exists
   *
   * Adding the same account twice used to create a second connection holding the same key — two rows
   * the operator had to tell apart by hand, both taking traffic, both billed to one credential. The
   * store keeps a **vault-local fingerprint** of each credential for exactly this check, and the rule
   * differs by kind because the two mean different things:
   *
   * - **An API key that is already saved** is accepted and *not* duplicated: the existing connection
   *   comes back, so the caller can say "this key is already account 2" rather than adding a twin.
   * - **The same sign-in again** updates the connection that holds it. Signing into one account twice
   *   is a renewal, not a second account, and the credential that comes back from the provider is
   *   fresher than the one on file.
   *
   * A genuinely different credential is a new account and saves normally — that is what
   * `addAccount` mints an id for.
   */
  async save(input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal, options: { tolerateDiscoveryFailure?: boolean } = {}): Promise<{ connection: ConnectionRecord; duplicate: 'none' | 'identical' | 'updated' }> {
    this.require();
    const existing = await this.findSameCredential(input.providerId, credential);
    if (existing && existing.id !== input.id) {
      if (credential.type === 'oauth') {
        const connection = await this.saveUnchecked({ ...input, id: existing.id }, credential, signal, options);
        return { connection, duplicate: 'updated' };
      }
      return { connection: existing, duplicate: 'identical' };
    }
    return { connection: await this.saveUnchecked(input, credential, signal, options), duplicate: 'none' };
  }

  /**
   * The connection already holding this credential, if any.
   *
   * Compared within one provider, because the fingerprint is keyed by provider id: the same string
   * used against two vendors is two credentials, not one. A provider whose card reads another's
   * connection (`clinepass` → `cline`) is compared under its owner, which is where the credential
   * actually lives.
   */
  private async findSameCredential(providerId: string, credential: ProviderCredential): Promise<ConnectionRecord | undefined> {
    // Fingerprinted under the **owner**, because that is the id the record was saved under. Keying it
    // on the card's own id made a shared card (`clinepass`) hash a different string than the `cline`
    // credential it reads, so the same sign-in was saved twice and neither row could see the other.
    const owner = this.deps.canonicalProviderId(providerId);
    const fingerprint = await this.deps.credentialFingerprint(owner, credential);
    const connections = await this.require().list();
    return connections.find((connection) => connection.providerId === owner && connection.credentialFingerprint === fingerprint);
  }

  private async saveUnchecked(input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal, options: { tolerateDiscoveryFailure?: boolean } = {}): Promise<ConnectionRecord> {
    this.require();
    // Not every provider can be probed without spending a request, so a capability without a
    // validator is saved without a pre-flight check. An unregistered provider is configuration for
    // a custom endpoint, which is validated when it is first used rather than at save time.
    return this.deps.lock(async () => {
      if (this.deps.canValidate(input.providerId)) {
        await this.deps.validate(input.providerId, credential, signal);
      }
      let saveInput = input;
      if (input.modelPolicy) {
        // A sign-in that already came from the provider's own flow has proven the
        // credential, so a catalog that will not read is not a reason to throw the
        // session away. The connection is saved and the models arrive on the next read.
        const discovered = await this.deps
          .discover({ providerId: input.providerId, credential, policy: input.modelPolicy, ...(signal ? { signal } : {}), pendingEndpoint: { endpoint: input.endpoint, name: input.name } })
          .catch((error: unknown) => {
            if (!options.tolerateDiscoveryFailure) throw error;
            this.deps.noteDiscoveryFailure(error);
            return [];
          });
        const discoveredModelIds = discovered.map((model) => model.id);
        const existing = (await this.require().list()).find((connection) => (input.id ? connection.id === input.id : connection.providerId === input.providerId));
        const customModelIds = input.customModelIds ?? existing?.customModelIds ?? [];
        const discoveredMeta = modelMetaFor(discovered);
        saveInput = {
          ...input,
          modelIds: [...discoveredModelIds, ...customModelIds],
          customModelIds,
          // Custom ids are the operator's own and carry no catalog metadata, so only the
          // discovered half is described here.
          ...(discoveredMeta ? { modelMeta: { ...(input.modelMeta ?? {}), ...discoveredMeta } } : {}),
        };
      }
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'The connection save was cancelled.', { providerId: input.providerId });
      return this.storeCall('The local connection', (store) => store.save(saveInput, credential));
    });
  }

  /** Replaces a connection's model catalog with the operator's list. */
  async setModels(connectionId: string, modelIds: string[]): Promise<ConnectionRecord> {
    return this.deps.lock(async () => {
      const updated = await this.storeCall('The local model catalog', (store) => store.updateModels(connectionId, modelIds));
      if (!updated) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
      return updated;
    });
  }

  async remove(connectionId: string): Promise<void> {
    const removed = await this.deps.lock(() => this.storeCall('The local connection', (store) => store.remove(connectionId)));
    if (!removed) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
  }

  async setResilience(connectionId: string, resilience: Partial<ResilienceSettings>): Promise<ConnectionRecord> {
    return this.deps.lock(async () => {
      const updated = await this.storeCall('The connection settings', (store) => store.updateResilience(connectionId, resilience));
      if (!updated) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
      return updated;
    });
  }

  /**
   * Writes the ownership note on a connection.
   *
   * Stored on the record with everything else, so a reader of the connection sees it in the same place
   * as the endpoint and the policy. `undefined` clears it, which is how the page removes a note.
   */
  async setResponsibility(connectionId: string, responsibility: { owner?: string; purpose?: string }): Promise<ConnectionRecord> {
    return this.deps.lock(async () => {
      const updated = await this.storeCall('The connection responsibility', (store) => store.setResponsibility(connectionId, responsibility));
      if (!updated) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
      return updated;
    });
  }

  /** Pauses or resumes one account. Metadata only: nothing is re-validated and no catalog is re-read. */
  async setEnabled(connectionId: string, enabled: boolean): Promise<ConnectionRecord> {
    return this.deps.lock(async () => {
      const updated = await this.storeCall('The connection state', (store) => store.setEnabled(connectionId, enabled));
      if (!updated) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
      return updated;
    });
  }

  /**
   * Re-reads a provider's catalog and replaces what is stored with it.
   *
   * `replace`, not add: the provider is the authority on what it serves, and a union here would
   * keep a withdrawn model forever and file it as a custom addition besides. Custom ids are the
   * operator's own and survive.
   *
   * Takes no lock and applies no error mapping, both on purpose. A rescan is a slow read of a
   * third party, and holding the mutation lock across it would make every save in the gateway queue
   * behind it.
   */
  async refreshModels(connectionId: string, signal?: AbortSignal): Promise<ConnectionRecord> {
    const store = this.require();
    const record = (await store.list()).find((item) => item.id === connectionId);
    if (!record) throw new ProviderError('NOT_FOUND', 'That connection no longer exists.', { providerId: connectionId });
    const credential = (await this.deps.readCredential(connectionId, record.providerId)) ?? ({ type: 'none' } as ProviderCredential);
    const policy = record.modelPolicy ?? 'all';
    const discovered = await this.deps.discover({ providerId: record.providerId, credential, policy, ...(signal ? { signal } : {}), pendingEndpoint: { endpoint: record.endpoint, name: record.name } });
    const merged = [...new Set([...discovered.map((model) => model.id), ...(record.customModelIds ?? [])])];
    const updated = await store.updateModels(connectionId, merged, modelMetaFor(discovered), { replace: true });
    if (!updated) throw new ProviderError('NOT_FOUND', 'That connection no longer exists.', { providerId: connectionId });
    return updated;
  }
}
