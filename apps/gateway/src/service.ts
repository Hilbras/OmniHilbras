import { OpenAICompatibleAdapter, ProviderError, type ChatChunk, type ChatRequest, type ChatResponse, type Model, type ModelImportPolicy, type ProviderAdapter, type ProviderCredential, type ProviderHealth, type ProviderRegistry, type ProviderRequestContext, type SecretStore } from '@omnihilbras/hilbras';
import { ApiKeyLimitError, type ApiKeyRecord, type ApiKeyStore, type CreatedApiKey } from './api-keys.js';
import { ConnectionMetadataLimitError, ConnectionModelLimitError, defaultResilienceSettings, type ConnectionInput, type ConnectionRecord, type ConnectionStore, type ResilienceSettings } from './connections.js';
import { HealthRegistry, SlidingWindowRateLimiter, isRetryableFailure, noCandidateMessage, resolveRoute, type RouteCandidate } from './routing.js';

export type GatewayProviderHealth = ProviderHealth & {
  providerId: string;
};

export type GatewayModelList = {
  models: Model[];
  unavailable: Array<{ providerId: string; code: string }>;
};

export type GatewayConnectionValidation = {
  providerId: string;
  valid: true;
  checkedAt: string;
  latencyMs?: number;
};

export type GatewayApiKeyList = {
  keys: ApiKeyRecord[];
  requireApiKey: boolean;
};

const connectionMutationLock = 'connection-mutations';
const apiKeyMutationLock = 'api-key-mutations';
const defaultProviderId = 'openai';
/** Consecutive failures before routing stops sending traffic to a connection. */
const defaultFailureThreshold = 3;
/** How often background health polling runs. 0 disables it. */
const defaultHealthIntervalMs = 60_000;

export type GatewayFailoverAttempt = {
  providerId: string;
  attempt: number;
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
};

export type GatewayChatOutcome = {
  response: ChatResponse;
  attempts: GatewayFailoverAttempt[];
};

export type GatewayStreamOutcome = {
  chunks: AsyncIterable<ChatChunk>;
  attempts: GatewayFailoverAttempt[];
};

export type GatewayServiceOptions = {
  /** Consecutive failures before a connection stops receiving traffic. */
  failureThreshold?: number;
  /** How long an ejected connection waits before one probe request. */
  recoveryCooldownMs?: number;
  /** Injectable clock for the rate limiter and recovery cooldown. */
  now?: () => number;
};

/** Error codes that mean "this request can never succeed on this route". */
const terminalRouteCodes = new Set(['INVALID_REQUEST', 'AUTHENTICATION_FAILED', 'NOT_SUPPORTED', 'NOT_FOUND']);

function noRouteAvailable(skipped: Array<{ providerId: string; reason: string }>) {
  const detail = skipped.length > 0 ? ` Skipped: ${skipped.map((entry) => `${entry.providerId} (${entry.reason})`).join(', ')}.` : '';
  return new ProviderError('PROVIDER_UNAVAILABLE', `${noCandidateMessage}${detail}`, { retryable: true, publicMessage: `${noCandidateMessage}${detail}` });
}

function attachAttempts(error: unknown, attempts: GatewayFailoverAttempt[]) {
  const failedProviders = [...new Set(attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId))];
  if (error instanceof ProviderError) {
    // A single route keeps the adapter's own redacted public message, so existing
    // error semantics do not change when failover never engaged.
    if (failedProviders.length <= 1) {
      const suffix = failedProviders.length === 1 ? ` Tried: ${failedProviders[0]}.` : '';
      return new ProviderError(error.code, `${error.message}${suffix}`, {
        ...(error.providerId ? { providerId: error.providerId } : {}),
        ...(error.statusCode ? { statusCode: error.statusCode } : {}),
        retryable: error.retryable,
        ...(error.publicMessage ? { publicMessage: `${error.publicMessage}${suffix}` } : {}),
        cause: error,
      });
    }
    if (terminalRouteCodes.has(error.code)) {
      return new ProviderError(error.code, `${error.message} Tried: ${failedProviders.join(', ')}.`, { ...(error.providerId ? { providerId: error.providerId } : {}), ...(error.statusCode ? { statusCode: error.statusCode } : {}), retryable: error.retryable, cause: error });
    }
    const message = `Every provider route failed. Tried: ${failedProviders.join(', ')}.`;
    return new ProviderError('PROVIDER_UNAVAILABLE', message, { retryable: true, publicMessage: message, cause: error });
  }
  const message = `Every provider route failed.${failedProviders.length > 0 ? ` Tried: ${failedProviders.join(', ')}.` : ''}`;
  return new ProviderError('PROVIDER_REQUEST_FAILED', message, { retryable: true, publicMessage: message, cause: error });
}
const missingApiKeyMessage = 'This gateway requires an API key. Create one on the API keys page and send it as "Authorization: Bearer <key>".';
const invalidApiKeyMessage = 'The API key is invalid or paused.';

export class GatewayService {
  private readonly connectionLocks = new Map<string, Promise<void>>();
  private readonly dynamicAdapters = new Map<string, { endpoint: string; adapter: ProviderAdapter }>();
  private readonly providerHealth: HealthRegistry;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly rateLimitWaitMs = new Map<string, number>();
  private failureThreshold = defaultFailureThreshold;
  private healthIntervalMs = defaultHealthIntervalMs;
  private healthTimer?: NodeJS.Timeout;

  constructor(
    readonly registry: ProviderRegistry,
    private readonly secretStore: SecretStore,
    private readonly connectionStore?: ConnectionStore,
    private readonly apiKeyStore?: ApiKeyStore,
    options: GatewayServiceOptions = {},
  ) {
    if (options.failureThreshold !== undefined) this.failureThreshold = options.failureThreshold;
    const now = options.now ?? (() => Date.now());
    this.providerHealth = new HealthRegistry(now, options.recoveryCooldownMs);
    this.rateLimiter = new SlidingWindowRateLimiter(now);
  }

  /** How often background health polling runs. 0 keeps polling off. */
  setHealthInterval(intervalMs: number) {
    this.healthIntervalMs = intervalMs;
    if (this.healthTimer) this.startHealthMonitor();
  }

  /** Starts background health polling so routing reflects reality without a request. */
  startHealthMonitor(intervalMs = this.healthIntervalMs) {
    this.stopHealthMonitor();
    this.healthIntervalMs = intervalMs;
    if (intervalMs <= 0) return;
    this.healthTimer = setInterval(() => { void this.refreshHealth(); }, intervalMs);
    this.healthTimer.unref?.();
    void this.refreshHealth();
  }

  stopHealthMonitor() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  /** Polls every configured adapter and folds the result into routing state. */
  async refreshHealth(signal?: AbortSignal): Promise<{ status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] }> {
    const providers = await Promise.all((await this.activeAdapters()).map(async (adapter) => {
      if (!adapter.healthCheck) return { providerId: adapter.id, status: 'unavailable' as const, checkedAt: new Date().toISOString(), message: 'Health checks are not supported.' };
      const startedAt = Date.now();
      try {
        const health = await adapter.healthCheck(await this.context(adapter.id, signal));
        this.providerHealth.recordSuccess(adapter.id, health.latencyMs ?? Date.now() - startedAt, health.checkedAt);
        return { providerId: adapter.id, ...health };
      } catch {
        this.providerHealth.recordFailure(adapter.id, 'PROVIDER_UNAVAILABLE', 'The provider health check failed.');
        return { providerId: adapter.id, status: 'unavailable' as const, checkedAt: new Date().toISOString() };
      }
    }));
    const result = {
      status: providers.some((provider) => provider.status !== 'healthy') ? 'degraded' as const : 'ok' as const,
      checkedAt: new Date().toISOString(),
      providers,
    };
    this.rateLimiter.prune();
    return result;
  }

  /** Live routing state for the dashboard. */
  async describeRouting() {
    const connections = await this.listConnections();
    return {
      failureThreshold: this.failureThreshold,
      connections: connections.map((connection) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        enabled: connection.enabled,
        hasCredential: connection.hasCredential,
        resilience: connection.resilience,
        ...(this.providerHealth.snapshot(connection.providerId, this.failureThreshold) ?? {}),
      })),
    };
  }

  async health(signal?: AbortSignal): Promise<{ status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] }> {
    return this.refreshHealth(signal);
  }

  /**
   * Adapters that can actually serve traffic: registered ones plus an
   * OpenAI-compatible adapter per saved connection endpoint.
   */
  private async activeAdapters(): Promise<ProviderAdapter[]> {
    const adapters = new Map(this.registry.list().map((adapter) => [adapter.id, adapter]));
    for (const connection of await this.listConnections()) {
      if (adapters.has(connection.providerId)) continue;
      const cached = this.dynamicAdapters.get(connection.providerId);
      adapters.set(connection.providerId, cached && cached.endpoint === connection.endpoint
        ? cached.adapter
        : new OpenAICompatibleAdapter({ id: connection.providerId, name: connection.name, baseUrl: connection.endpoint }));
    }
    return [...adapters.values()];
  }

  async listAllModels(signal?: AbortSignal): Promise<GatewayModelList> {
    const connections = (await this.listConnections()).filter((connection) => connection.enabled && connection.hasCredential);
    if (connections.length > 0) {
      // Advertise the saved catalog so clients only see models this gateway
      // actually routes, instead of a provider's full paid inventory.
      return {
        models: connections.flatMap((connection) => connection.modelIds.map((id) => ({ id, providerId: connection.providerId } satisfies Model))),
        unavailable: [],
      };
    }

    const results = await Promise.all(this.registry.list().map(async (adapter) => {
      if (!adapter.listModels || adapter.capabilities.models !== true) return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: 'NOT_SUPPORTED' } };
      try {
        return { providerId: adapter.id, models: await adapter.listModels(await this.context(adapter.id, signal)), unavailable: undefined };
      } catch (error) {
        return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED' } };
      }
    }));
    return {
      models: results.flatMap((result) => result.models),
      unavailable: results.flatMap((result) => result.unavailable ? [result.unavailable] : []),
    };
  }

  /**
   * Resolves which provider should serve a model. An explicit request wins;
   * otherwise the saved connection catalog decides, so a plain OpenAI-compatible
   * client only needs a base URL, a key, and a model ID.
   */
  async resolveProviderId(model: string, explicitProviderId?: string) {
    if (explicitProviderId) return explicitProviderId;
    const modelId = model.trim();
    if (!modelId) return defaultProviderId;
    const connections = (await this.listConnections()).filter((connection) => connection.enabled && connection.hasCredential);
    const owners = [...new Set(connections.filter((connection) => connection.modelIds.includes(modelId)).map((connection) => connection.providerId))];
    if (owners.length === 1) return owners[0]!;
    if (owners.length > 1) {
      const chatCapable = (await this.activeAdapters()).find((adapter) => owners.includes(adapter.id) && adapter.capabilities.chat === true);
      return chatCapable?.id ?? owners[0]!;
    }
    if (connections.length === 1) return connections[0]!.providerId;
    return defaultProviderId;
  }

  async listModels(providerId: string, signal?: AbortSignal) {
    const adapter = this.requireAdapter(providerId);
    if (!adapter.listModels || adapter.capabilities.models !== true) throw notSupported(adapter, 'models');
    return adapter.listModels(await this.context(adapter.id, signal));
  }

  async validateConnectionCredential(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    return this.withProviderLock(providerId, () => this.validateConnectionCredentialUnlocked(providerId, credential, signal));
  }

  async saveConnection(input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal): Promise<ConnectionRecord> {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    // An unregistered provider is configuration for a custom endpoint, which is
    // validated when it is first used rather than at save time.
    this.registry.get(input.providerId);
    return this.withProviderLock(connectionMutationLock, async () => {
      // Not every provider can be probed without spending a request, so a
      // capability without a validator is saved without a pre-flight check.
      if (this.registry.get(input.providerId)?.validateCredential) {
        await this.validateConnectionCredentialUnlocked(input.providerId, credential, signal);
      }
      let saveInput = input;
      if (input.modelPolicy) {
        const discoveredModelIds = await this.discoverConnectionModels(input.providerId, credential, input.modelPolicy, signal, { endpoint: input.endpoint, name: input.name });
        const existing = (await this.connectionStore!.list()).find((connection) => (input.id ? connection.id === input.id : connection.providerId === input.providerId));
        const customModelIds = input.customModelIds ?? existing?.customModelIds ?? [];
        saveInput = { ...input, modelIds: [...discoveredModelIds, ...customModelIds], customModelIds };
      }
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'The connection save was cancelled.', { providerId: input.providerId });
      try {
        return await this.connectionStore!.save(saveInput, credential);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ConnectionModelLimitError || error instanceof ConnectionMetadataLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local connection could not be saved.', { cause: error });
      }
    });
  }

  async listConnections() {
    return this.connectionStore?.list() ?? [];
  }

  async addConnectionModels(connectionId: string, modelIds: string[]) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.withProviderLock(connectionMutationLock, async () => {
      try {
        const connection = await this.connectionStore!.updateModels(connectionId, modelIds);
        if (!connection) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
        return connection;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ConnectionModelLimitError || error instanceof ConnectionMetadataLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local model catalog could not be saved.', { cause: error });
      }
    });
  }

  async removeConnection(connectionId: string) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.withProviderLock(connectionMutationLock, async () => {
      const removed = await this.connectionStore!.remove(connectionId);
      if (!removed) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
    });
  }

  async listApiKeys(): Promise<GatewayApiKeyList> {
    if (!this.apiKeyStore) return { keys: [], requireApiKey: false };
    const [keys, requireApiKey] = await Promise.all([this.apiKeyStore.list(), this.apiKeyStore.isEnforced()]);
    return { keys, requireApiKey };
  }

  async createApiKey(name: string): Promise<CreatedApiKey> {
    return this.withApiKeyMutation(() => this.apiKeyStore!.create(name));
  }

  async setApiKeyEnabled(id: string, enabled: boolean) {
    return this.withApiKeyMutation(async () => {
      const record = await this.apiKeyStore!.setEnabled(id, enabled);
      if (!record) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
      return record;
    });
  }

  async removeApiKey(id: string) {
    return this.withApiKeyMutation(async () => {
      const removed = await this.apiKeyStore!.remove(id);
      if (!removed) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
    });
  }

  async setRequireApiKey(value: boolean) {
    return this.withApiKeyMutation(() => this.apiKeyStore!.setEnforced(value));
  }

  /**
   * Guards the public LLM surface. Callers that are already trusted local
   * administration surfaces (the dashboard) must not call this.
   */
  async authorizePublicRequest(presentedKey: string | undefined) {
    // Embedders and unit tests construct the service without key storage.
    if (!this.apiKeyStore || !(await this.apiKeyStore.isEnforced())) return;
    if (!presentedKey) throw new ProviderError('AUTHENTICATION_FAILED', missingApiKeyMessage, { publicMessage: missingApiKeyMessage });
    if (!(await this.apiKeyStore.authenticate(presentedKey))) throw new ProviderError('AUTHENTICATION_FAILED', invalidApiKeyMessage, { publicMessage: invalidApiKeyMessage });
  }

  async updateConnectionResilience(connectionId: string, resilience: Partial<ResilienceSettings>) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.withProviderLock(connectionMutationLock, async () => {
      try {
        const connection = await this.connectionStore!.updateResilience(connectionId, resilience);
        if (!connection) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
        return connection;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ConnectionMetadataLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The connection settings could not be saved.', { cause: error });
      }
    });
  }

  async chat(providerId: string, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const adapter = await this.resolveAdapter(providerId);
    if (!adapter.chat || adapter.capabilities.chat !== true) throw notSupported(adapter, 'chat');
    return adapter.chat(request, await this.context(adapter.id, signal));
  }

  async *streamChat(providerId: string, request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const adapter = await this.resolveAdapter(providerId);
    if (!adapter.streamChat || adapter.capabilities.streaming !== true) throw notSupported(adapter, 'streaming');
    yield* adapter.streamChat(request, await this.context(adapter.id, signal));
  }

  /**
   * Serves one request across a failover chain: each candidate gets its own
   * retry budget, and a retryable failure moves on to the next connection.
   */
  async chatWithFailover(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal): Promise<GatewayChatOutcome> {
    const decision = await this.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    const race = await this.tryHedgedRace(decision.candidates, request, signal);
    if (race) {
      attempts.push(...race.attempts);
      if (race.response) return { response: race.response, attempts };
      // The race found no winner; continue down the normal chain.
    }
    const racedProviders = new Set(race?.attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId));
    let lastError: unknown = race?.lastError;

    for (const candidate of decision.candidates) {
      if (racedProviders.has(candidate.providerId)) continue;
      for (let attempt = 1; attempt <= candidate.resilience.maxRetries + 1; attempt += 1) {
        if (signal?.aborted) throw new ProviderError('CANCELLED', 'The request was cancelled.', { cause: signal.reason });
        const startedAt = Date.now();
        try {
          this.enforceRateLimit(candidate);
          const response = await this.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => this.chat(candidate.providerId, request, deadline));
          const latencyMs = Date.now() - startedAt;
          this.providerHealth.recordSuccess(candidate.providerId, latencyMs);
          this.rateLimiter.record(candidate.connectionId);
          attempts.push({ providerId: candidate.providerId, attempt, ok: true, latencyMs });
          return { response, attempts };
        } catch (error) {
          const latencyMs = Date.now() - startedAt;
          const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
          this.providerHealth.recordFailure(candidate.providerId, code, error instanceof Error ? error.message : 'The provider request failed.');
          attempts.push({ providerId: candidate.providerId, attempt, ok: false, latencyMs, errorCode: code });
          // A per-connection limit should hand off to the next route, not retry here.
          if (error instanceof ProviderError && error.code === 'RATE_LIMITED' && attempts.length > 1) break;
          if (!isRetryableFailure(error)) throw attachAttempts(error, attempts);
          lastError = error;
          if (signal?.aborted) break;
        }
      }
    }
    throw attachAttempts(lastError, attempts);
  }

  /**
   * Races the leading candidates when a hedge delay is configured. The first
   * successful reply wins and the losers are aborted, so the client waits for
   * the fastest route instead of the first-priority one. A hedge is only sent
   * while the leader is still in flight and another candidate can serve the
   * model, so a single connection never pays the extra cost.
   */
  private async tryHedgedRace(candidates: RouteCandidate[], request: ChatRequest, signal: AbortSignal | undefined) {
    const [leader, ...rest] = candidates;
    if (!leader || rest.length === 0 || leader.resilience.hedgeAfterMs <= 0) return undefined;

    type Outcome = { candidate: RouteCandidate; ok: boolean; latencyMs: number; response?: ChatResponse; error?: unknown };
    const attempts: GatewayFailoverAttempt[] = [];
    const inflight: Array<{ candidate: RouteCandidate; abort: () => void; done: Promise<Outcome>; startedAt: number }> = [];
    const settled = new Set<Promise<Outcome>>();
    const started = new Set<RouteCandidate>();
    let winner: Outcome | undefined;
    let lastError: unknown;
    let onChange: () => void = () => undefined;
    const resetChange = () => new Promise<void>((resolve) => { onChange = resolve; });

    const start = (candidate: RouteCandidate) => {
      started.add(candidate);
      const controller = new AbortController();
      const startedAt = Date.now();
      const done = this.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => this.chat(candidate.providerId, request, deadline))
        .then(
          (response): Outcome => ({ candidate, ok: true, latencyMs: Date.now() - startedAt, response }),
          (error: unknown): Outcome => ({ candidate, ok: false, latencyMs: Date.now() - startedAt, error }),
        )
        .then((outcome) => {
          settled.add(done);
          const code = outcome.ok ? undefined : outcome.error instanceof ProviderError ? outcome.error.code : 'PROVIDER_REQUEST_FAILED';
          if (outcome.ok) {
            this.providerHealth.recordSuccess(candidate.providerId, outcome.latencyMs);
            this.rateLimiter.record(candidate.connectionId);
          } else {
            this.providerHealth.recordFailure(candidate.providerId, code ?? 'PROVIDER_REQUEST_FAILED', outcome.error instanceof Error ? outcome.error.message : 'The provider request failed.');
          }
          attempts.push({ providerId: candidate.providerId, attempt: 1, ok: outcome.ok, latencyMs: outcome.latencyMs, ...(code ? { errorCode: code } : {}) });
          if (outcome.ok) {
            if (!winner) {
              winner = outcome;
              // A faster route answered: stop paying for the others. The
              // abandoned attempts are recorded now so the client can see that
              // a hedge was fired and won.
              for (const other of inflight) {
                if (other.candidate === candidate) continue;
                other.abort();
                if (!settled.has(other.done)) {
                  attempts.push({ providerId: other.candidate.providerId, attempt: 1, ok: false, latencyMs: Date.now() - other.startedAt, errorCode: 'CANCELLED' });
                }
              }
            }
          } else {
            lastError = outcome.error;
          }
          onChange();
          return outcome;
        });
      inflight.push({ candidate, done, startedAt, abort: () => controller.abort(new ProviderError('CANCELLED', 'A faster provider answered this request.')) });
      return done;
    };

    start(leader);
    let hedgePending = true;
    const hedgeTimer = setInterval(() => {
      if (winner || signal?.aborted) {
        clearInterval(hedgeTimer);
        hedgePending = false;
        return;
      }
      // Only hedge while the leader is still in flight.
      if (settled.size > 0) {
        clearInterval(hedgeTimer);
        hedgePending = false;
        return;
      }
      const next = rest.find((candidate) => !started.has(candidate));
      if (next) {
        start(next);
        onChange();
      } else {
        clearInterval(hedgeTimer);
        hedgePending = false;
      }
    }, leader.resilience.hedgeAfterMs);
    hedgeTimer.unref?.();

    // Wait for the first success, or until every candidate has been tried.
    while (!winner) {
      const running = inflight.filter((handle) => !settled.has(handle.done));
      if (running.length === 0) {
        if (hedgePending) {
          // The hedge timer decides whether another candidate is worth starting.
          await resetChange();
          continue;
        }
        break;
      }
      await resetChange();
    }
    clearInterval(hedgeTimer);
    if (winner) {
      // Return immediately: the losers were aborted and their own bookkeeping
      // continues in the background. Waiting for them would reintroduce the
      // leader's latency, which is exactly what hedging exists to avoid.
      return { response: winner.response!, attempts, lastError };
    }
    await Promise.allSettled(inflight.map((handle) => handle.done));
    return attempts.length === 0 ? undefined : { response: undefined, attempts, lastError };
  }

  /** Streaming cannot retry after bytes are sent, so failover only covers the first chunk. */
  async streamChatWithFailover(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal): Promise<GatewayStreamOutcome> {
    const decision = await this.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    let lastError: unknown;

    for (const candidate of decision.candidates) {
      const startedAt = Date.now();
      let opening: ChatChunk | undefined;
      let rest: AsyncIterator<ChatChunk> | undefined;
      try {
        this.enforceRateLimit(candidate);
        const opened = await this.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, async (deadline) => {
          const source = this.streamChat(candidate.providerId, request, deadline)[Symbol.asyncIterator]();
          const first = await source.next();
          if (first.done) throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before producing a chunk.');
          // The deadline has passed; the rest of the stream continues without it.
          const remainder = (async function* (): AsyncGenerator<ChatChunk> {
            while (true) {
              const next = await source.next();
              if (next.done) return;
              yield next.value;
            }
          })();
          return { first: first.value, remainder };
        });
        opening = opened.first;
        rest = opened.remainder[Symbol.asyncIterator]();
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
        this.providerHealth.recordFailure(candidate.providerId, code, error instanceof Error ? error.message : 'The provider stream failed.');
        attempts.push({ providerId: candidate.providerId, attempt: 1, ok: false, latencyMs: Date.now() - startedAt, errorCode: code });
        lastError = error;
        if (!isRetryableFailure(error) || signal?.aborted) break;
        continue;
      }
      this.rateLimiter.record(candidate.connectionId);
      attempts.push({ providerId: candidate.providerId, attempt: 1, ok: true, latencyMs: Date.now() - startedAt });
      const settled = opening;
      return {
        attempts,
        chunks: (async function* (self: GatewayService) {
          if (settled) yield settled;
          try {
            while (true) {
              const next = await rest!.next();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            self.providerHealth.recordSuccess(candidate.providerId, Date.now() - startedAt);
          }
        })(this),
      };
    }
    throw attachAttempts(lastError, attempts);
  }

  private async planRoute(model: string, explicitProviderId?: string) {
    const connections = await this.listConnections();
    const decision = resolveRoute({
      connections,
      model,
      ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
      health: this.providerHealth,
      failureThreshold: this.failureThreshold,
      rateLimitWaitMs: this.rateLimitWaitMs,
    });
    if (decision.candidates.length > 0) return decision;
    // Without connection metadata there is nothing to route on, so an embedded
    // service still serves the requested provider directly.
    if (connections.length === 0) {
      const providerId = explicitProviderId ?? defaultProviderId;
      this.requireAdapter(providerId);
      return { ...decision, candidates: [{ providerId, connectionId: `unmanaged:${providerId}`, priority: 0, resilience: { ...defaultResilienceSettings } }] };
    }
    return decision;
  }

  private enforceRateLimit(candidate: RouteCandidate) {
    const waitMs = this.rateLimiter.check(candidate.connectionId, candidate.resilience.requestsPerMinute);
    this.rateLimitWaitMs.set(candidate.connectionId, waitMs);
    if (waitMs > 0) {
      throw new ProviderError('RATE_LIMITED', `This connection reached its limit of ${candidate.resilience.requestsPerMinute} requests per minute.`, {
        providerId: candidate.providerId,
        retryable: true,
      });
    }
  }

  /**
   * Applies a per-connection deadline without leaking timers: the timeout aborts
   * the provider call, and the timer is always released once the call settles.
   */
  private async withDeadline<T>(signal: AbortSignal | undefined, timeoutMs: number, providerId: string, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    if (timeoutMs <= 0) return run(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline is enforced here rather than trusted to the adapter, so a
    // provider that ignores the abort signal still cannot hang the request.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError('PROVIDER_TIMEOUT', `The provider did not respond within ${timeoutMs} ms.`, { providerId, retryable: true }));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async discoverConnectionModels(providerId: string, credential: ProviderCredential, policy: ModelImportPolicy, signal?: AbortSignal, pendingEndpoint?: { endpoint: string; name: string }) {
    const adapter = await this.resolveAdapter(providerId, pendingEndpoint);
    const context: ProviderRequestContext = { credential, ...(signal ? { signal } : {}) };
    const models = adapter.discoverModels
      ? await adapter.discoverModels(context, { policy })
      : policy === 'all' && adapter.listModels && adapter.capabilities.models === true
        ? await adapter.listModels(context)
        : undefined;
    if (!models) throw notSupported(adapter, policy === 'free' ? 'free model discovery' : 'model discovery');
    return models.map((model) => model.id);
  }

  private async validateConnectionCredentialUnlocked(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    const adapter = this.requireAdapter(providerId);
    const context: ProviderRequestContext = { credential, ...(signal ? { signal } : {}) };
    if (!adapter.validateCredential) throw notSupported(adapter, 'credential validation');
    const result = await adapter.validateCredential(credential, context);
    return { providerId, valid: true, checkedAt: result?.checkedAt ?? new Date().toISOString(), ...(result?.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }) };
  }

  private async withApiKeyMutation<T>(operation: () => Promise<T>) {
    if (!this.apiKeyStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local API key storage is not configured.');
    return this.withProviderLock(apiKeyMutationLock, async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ApiKeyLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local API key store could not be updated.', { cause: error });
      }
    });
  }

  private async withProviderLock<T>(providerId: string, operation: () => Promise<T>) {
    const previous = this.connectionLocks.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.connectionLocks.set(providerId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.connectionLocks.get(providerId) === current) this.connectionLocks.delete(providerId);
    }
  }

  private requireAdapter(providerId: string): ProviderAdapter {
    return this.registry.require(providerId);
  }

  /**
   * Resolves the adapter for a provider, building one on demand for a saved
   * connection that has no registered adapter. That is what lets any
   * OpenAI-compatible endpoint added through the dashboard serve traffic, using
   * the same transport and credential vault as the built-in adapters.
   */
  private async resolveAdapter(providerId: string, pendingEndpoint?: { endpoint: string; name: string }): Promise<ProviderAdapter> {
    const registered = this.registry.get(providerId);
    if (registered) return registered;
    // A connection being saved is not in the store yet, so the caller can pass
    // the endpoint it is about to use.
    const connection = (await this.listConnections()).find((item) => item.providerId === providerId);
    const endpoint = pendingEndpoint ?? (connection ? { endpoint: connection.endpoint, name: connection.name } : undefined);
    if (!endpoint) return this.registry.require(providerId);
    const cached = this.dynamicAdapters.get(providerId);
    if (cached && cached.endpoint === endpoint.endpoint) return cached.adapter;
    const adapter = new OpenAICompatibleAdapter({ id: providerId, name: endpoint.name, baseUrl: endpoint.endpoint });
    this.dynamicAdapters.set(providerId, { endpoint: endpoint.endpoint, adapter });
    return adapter;
  }

  private async context(providerId: string, signal?: AbortSignal): Promise<ProviderRequestContext> {
    return {
      credential: await this.secretStore.get(providerId),
      ...(signal ? { signal } : {}),
    };
  }
}

function notSupported(adapter: ProviderAdapter, capability: string) {
  const message = `${adapter.name} does not support ${capability}.`;
  return new ProviderError('NOT_SUPPORTED', message, { providerId: adapter.id, publicMessage: message });
}
