import { RateLimitPolicy } from './rate-limit-policy.js';
import { defaultResilienceSettings, type ConnectionRecord, type ResilienceSettings } from './connections.js';
import { providerPrefixes } from './index.js';
import {
  SlidingWindowRateLimiter, bareModelFor, enabledCapacityPoolModels, lookupModelId, modelSatisfiesCapabilities,
  resolveRoute, splitProviderPrefix,
  type CapacityAdapterConfig, type CapacityCapability, type RouteCandidate, type RouteDecision,
} from './routing.js';
import type { HealthManager } from './health.js';

/**
 * Which routes a request may take, given what is currently true.
 *
 * The last piece of routing that lived outside `routing.ts`. `planRoute` was twenty lines in the
 * composition root, and each of them reached for a different piece of state owned by someone else:
 * the health registry, the failure threshold, the rate limiter's last-seen waits, and the default
 * resilience settings. So the *algorithm* was in `routing.ts` and the *inputs* were scattered
 * across a class — which is the shape that makes a routing change look like a service change.
 *
 * ## What "unmanaged" means, and why it exists
 *
 * With no saved connections there is nothing to route on: no credentials, no catalogs, no health.
 * An embedded service — someone constructing a `GatewayService` with a registry and a secret store
 * and no connection store — would otherwise be handed an empty route list and told no provider can
 * serve the model, which is a confusing way of saying *you have not configured anything yet*.
 *
 * So an unconfigured gateway serves the requested provider directly, with default resilience. It is
 * labelled `unmanaged:` in the connection id so nothing later mistakes it for a real connection and
 * tries to read its credential or record health against it.
 */

/** What the engine needs to know about health, asked as two questions rather than as a service. */
export type RoutingHealth = Pick<HealthManager, 'getFailureThreshold'> & {
  registry: () => ReturnType<HealthManager['snapshotRegistry']>;
};

export type RoutingEngineOptions = {
  health: RoutingHealth;
  rateLimiter: SlidingWindowRateLimiter;
  /** A saved alias: a requested name mapped to the provider and model it should reach. */
  aliasFor?: (name: string) => { providerId: string; model: string } | undefined;
  /** A provider's model family, as its registration declares it. Used to route a bare model name within its family. */
  familyOf?: (providerId: string) => string | undefined;
  /**
   * A provider's strategy.
   *
   * - `round-robin` balances all of that provider's connections;
   * - `fastest` orders same-priority connections by their measured latency, unmeasured last;
   * - absent or `priority` leaves them alone.
   */
  strategyFor?: (providerId: string) => 'priority' | 'round-robin' | 'fastest';
  /**
   * The measured round trip for one connection, or `undefined` when it has never served a request.
   * Read only by the `fastest` strategy, and deliberately **per connection**: two accounts of one
   * provider are not equally fast, which is the whole reason the ledger is keyed that way.
   */
  latencyFor?: (connectionId: string) => { latencyMs: number; samples: number } | undefined;
  /** Sticky connection preferred for a model, when still a candidate. */
  stickyFor?: (modelId: string) => string | undefined;
  /**
   * Explicit capability pools. Absent means no substitution: a capability no planned model declares
   * can only be satisfied by models the operator named here.
   */
  capacityAdapter?: CapacityAdapterConfig;
  /** The catalog's per-model capability facts, asked of the connection records that were passed in. */
  capabilitiesFor?: (connection: ConnectionRecord, modelId: string) => ReadonlySet<CapacityCapability>;
  /**
   * The provider to serve when nothing is configured.
   *
   * A parameter rather than a constant, because the Core should not carry a provider's name as a
   * default any more than it should carry one in a branch.
   */
  defaultProviderId: string;
  /** Confirms a provider can be served at all, so an unknown one is named rather than invented. */
  requireAdapter: (providerId: string) => void;
};

export class RoutingEngine {
  private readonly limits: RateLimitPolicy;
  /** One turn counter per provider and priority, so balanced connections at one priority take turns across requests. */
  private readonly balanceTurns = new Map<string, number>();
  /** One turn counter per capability, used only by pools that ask for round-robin. */
  private readonly capacityTurns = new Map<CapacityCapability, number>();

  constructor(private readonly options: RoutingEngineOptions) {
    this.limits = new RateLimitPolicy({ limiter: options.rateLimiter });
  }

  /** The wait each connection was last told to observe, keyed by connection id. */
  waits(): ReadonlyMap<string, number> {
    return this.limits.observed();
  }

  /**
   * Releases what is held for connections that no longer exist.
   *
   * Called on the routing path with the live connection set, which is the only place in the process where
   * that set is known to be current. Doing it on a timer would be a guess, and hooking the connection
   * store's delete event would couple this engine to a store for no gain — `plan()` is already handed the
   * truth and already walks the connections.
   *
   * Both maps it prunes are invisible in the rendered page, which filters by the live connections, and that
   * invisibility is why the growth survived this long: nothing about the dashboard changes as it happens.
   */
  retain(liveConnectionIds: ReadonlySet<string>): void {
    this.limits.retain(liveConnectionIds);
    this.options.rateLimiter.retain(liveConnectionIds);
  }

  /**
   * The wait a connection faces right now, for the skip decision.
   *
   * A query against the limiter rather than a read of `waits()`, and that distinction is the fix in
   * 1.39.0. `plan()` used to skip on the *recorded* wait, which only `enforce()` ever wrote — and
   * `enforce()` runs on the candidates `plan()` has already returned. So the first refusal wrote a
   * positive wait, the next `plan()` skipped the connection for refusing, `enforce()` never ran again,
   * and nothing cleared it: a connection that hit its limit could never serve another request for the
   * life of the process.
   *
   * Asking the limiter is also the honest question. "Is this over its limit?" is about the window,
   * which the limiter owns; "what did routing last decide?" is a report about the past, and it was
   * standing in for the first.
   */
  private currentWait(candidate: RouteCandidate): number {
    return this.limits.currentWait(candidate);
  }

  /**
   * The ordered candidates for a request, or a decision with the reasons each was skipped.
   *
   * "Unmanaged" is a last resort, not a fallback: it applies only when there are no connections at
   * all. With connections present and every one skipped, the decision is returned as-is, because
   * *why* they were skipped is the answer the operator needs.
   */
  /** A connection balances when it asks to, or when its provider is set to round-robin. */
  private isBalanced(connection: ConnectionRecord): boolean {
    return connection.balance === true || this.options.strategyFor?.(connection.providerId) === 'round-robin';
  }

  /**
   * The turn for this request among balanced connections. It advances only for a priority that has more than one
   * balanced connection, so a single balanced connection, or none, never changes the order.
   */
  private nextBalanceTurn(connections: readonly ConnectionRecord[]): number {
    const groups = new Map<string, number>();
    for (const connection of connections) {
      if (!connection.enabled || !connection.hasCredential || !this.isBalanced(connection)) continue;
      const key = `${connection.providerId}:${connection.priority}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    let turn = 0;
    for (const [key, count] of groups) {
      if (count < 2) continue;
      const next = (this.balanceTurns.get(key) ?? 0) + 1;
      this.balanceTurns.set(key, next);
      turn = Math.max(turn, next);
    }
    return turn;
  }

  /**
   * Candidates from the configured capability pools, ahead of the originals.
   *
   * The substitution happens only when **none** of the planned models can serve the whole
   * requirement, which is the narrow rule that keeps an explicitly capable requested model in place.
   * A pool model is namespaced (`provider/model`) so the account that serves it is stated rather than
   * guessed; `resolveRoute` still applies health, cooldown and rate-limit checks to it. The returned
   * candidate carries the pool model as its wire id while the request's own id and skip reasons stay
   * untouched — the usage label names what the caller asked for, not what an adapter answered with.
   */
  private capacityCandidates(input: {
    connections: readonly ConnectionRecord[];
    model: string;
    required: readonly CapacityCapability[];
    original: readonly RouteCandidate[];
    health: ReturnType<RoutingHealth['registry']>;
    failureThreshold: number;
    rateLimitWaitMs: Map<string, number>;
  }): RouteCandidate[] {
    const config = this.options.capacityAdapter;
    const capabilitiesFor = this.options.capabilitiesFor;
    if (!config || !capabilitiesFor || input.required.length === 0) return [];

    const byId = new Map(input.connections.map((connection) => [connection.id, connection]));
    const alreadyCapable = input.original.some((candidate) => {
      const connection = byId.get(candidate.connectionId);
      if (!connection) return false;
      return modelSatisfiesCapabilities(connection, candidate.model ?? input.model, input.required);
    });
    if (alreadyCapable) return [];

    const added: RouteCandidate[] = [];
    const seen = new Set<string>();
    for (const capability of input.required) {
      const pool = config[capability];
      if (!pool || pool.enabled === false) continue;
      const models = enabledCapacityPoolModels(config, capability);
      if (models.length === 0) continue;
      const turn = this.capacityTurns.get(capability) ?? 0;
      this.capacityTurns.set(capability, turn + 1);
      const offset = pool.roundRobin === true && models.length > 1 ? turn % models.length : 0;
      const ordered = [...models.slice(offset), ...models.slice(0, offset)];
      for (const qualified of ordered) {
        if (seen.has(qualified)) continue;
        seen.add(qualified);
        const slash = qualified.indexOf('/');
        const prefix = slash > 0 ? qualified.slice(0, slash) : undefined;
        const model = bareModelFor(qualified, prefix ?? '');
        const owners = prefix
          ? input.connections.filter((connection) => connection.providerId === prefix || providerPrefixes(connection.providerId).includes(prefix))
          : input.connections.filter((connection) => connection.modelIds.some((id) => lookupModelId(id) === lookupModelId(model)));
        if (owners.length === 0) continue;
        const single = resolveRoute({
          connections: [...owners],
          model,
          health: input.health,
          failureThreshold: input.failureThreshold,
          rateLimitWaitMs: input.rateLimitWaitMs,
        });
        for (const candidate of single.candidates) {
          const connection = byId.get(candidate.connectionId);
          if (!connection || !modelSatisfiesCapabilities(connection, model, input.required)) continue;
          // `model` is the pool's own id, so the executor sends the adapter's model upstream. The
          // catalog's `u` is still applied by `upstreamModelFor` on the dispatch path.
          added.push({ ...candidate, model });
        }
      }
    }
    return added;
  }

  async plan(input: {
    connections: readonly ConnectionRecord[];
    model: string;
    explicitProviderId?: string;
    /** Hard capabilities the request needs, satisfied only by declared catalog modalities or explicit pools. */
    requiredCapabilities?: readonly CapacityCapability[];
    /**
     * A saved account to try **first**; its siblings remain behind it.
     *
     * It used to confine routing to that one connection, on the reasoning that a caller naming an
     * account chose it and serving elsewhere would be a substitution. That reasoning holds for *who
     * answers first* and fails for *who is never asked*: with one account out of quota the request
     * died while the provider's other accounts sat idle, and a model test pinned to an exhausted
     * account could only ever report a failure. An account is a preference now, not a fence — the
     * same conclusion the reference implementation reached with its per-account exclusion loop.
     */
    explicitConnectionId?: string;
  }): Promise<RouteDecision> {
    // The pinned account is promoted to the front rather than kept alone, so it is always the first
    // one spent and the rest stay reachable when it refuses.
    const pinned = input.explicitConnectionId === undefined
      ? undefined
      : input.connections.find((connection) => connection.id === input.explicitConnectionId);
    /**
     * A **disabled** account named by the caller is refused, not replaced.
     *
     * Different question from the exhausted one: "this account has no quota left" is a fact the next
     * account can help with, while "this account is paused" is an instruction. Serving the request from
     * a sibling would quietly undo the pause.
     */
    if (pinned && !pinned.enabled) {
      return { candidates: [], skipped: [{ providerId: pinned.providerId, reason: 'disabled' as const }] };
    }
    const connections = pinned === undefined
      ? input.connections
      : [pinned, ...input.connections.filter((connection) => connection.id !== pinned.id)];
    // Before anything is read or written. Two maps are keyed by connection id and only ever grew, so a
    // dashboard that deleted a connection kept its wait and its request window for the life of the process.
    // Measured at 2000 and 3000 stale entries respectively.
    this.retain(new Set(input.connections.map((connection) => connection.id)));

    const health = this.options.health.registry();
    const alias = this.options.aliasFor?.(input.model.trim());
    const split = alias ? { model: alias.model, providerId: alias.providerId } : splitProviderPrefix(input.model, connections);
    const explicitProviderId = input.explicitProviderId ?? split.providerId;
    const rotation = this.nextBalanceTurn(connections);
    const rateLimitWaitMs = new Map(
      connections.map((connection) => {
        const candidate: RouteCandidate = {
          providerId: connection.providerId,
          connectionId: connection.id,
          priority: connection.priority,
          resilience: connection.resilience,
        };
        return [connection.id, this.currentWait(candidate)] as const;
      }),
    );
    const decision = resolveRoute({
      // Copied because `resolveRoute` types its input as mutable while nothing here mutates it.
      // The copy is here rather than at every call site so the looseness is paid for once.
      connections: connections.map((connection) => (this.isBalanced(connection) ? { ...connection, balance: true } : connection)),
      model: split.model,
      rotation,
      ...(this.options.familyOf ? { familyOf: this.options.familyOf } : {}),
      ...(this.options.strategyFor ? { strategyFor: this.options.strategyFor } : {}),
      ...(this.options.latencyFor ? { latencyFor: this.options.latencyFor } : {}),
      ...(this.options.stickyFor ? { stickyFor: this.options.stickyFor } : {}),
      ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
      ...(input.explicitConnectionId === undefined ? {} : { pinnedConnectionId: input.explicitConnectionId }),
      health,
      failureThreshold: this.options.health.getFailureThreshold(),
      // Asked of the limiter, per connection, for this request — see `currentWait`. Passing
      // `this.limits.observed()` here is what bricked a limited connection for the life of the
      // process: the map only ever held the verdict of the last dispatch, and a refused connection
      // produced no further dispatch to correct it.
      rateLimitWaitMs,
    });
    // Capability pools widen the candidate set; they do not excuse the original incapable candidate.
    // A pinned provider or account is a deliberate choice, so pools are not consulted for it, but
    // an incapable pinned route is still refused rather than sent somewhere else.
    let candidates = decision.candidates;
    let skipped = decision.skipped;
    if (input.requiredCapabilities?.length) {
      if (input.explicitProviderId === undefined && input.explicitConnectionId === undefined) {
        const added = this.capacityCandidates({
          connections,
          model: split.model,
          required: input.requiredCapabilities,
          original: decision.candidates,
          health,
          failureThreshold: this.options.health.getFailureThreshold(),
          rateLimitWaitMs,
        });
        if (added.length > 0) candidates = [...added, ...candidates];
      }
      const byId = new Map(connections.map((connection) => [connection.id, connection]));
      const capable = candidates.filter((candidate) => {
        const connection = byId.get(candidate.connectionId);
        return connection !== undefined
          && modelSatisfiesCapabilities(connection, candidate.model ?? split.model, input.requiredCapabilities!);
      });
      if (capable.length !== candidates.length) {
        const refused = candidates
          .filter((candidate) => !capable.includes(candidate))
          .map((candidate) => ({ providerId: candidate.providerId, reason: 'no-capability' as const }));
        skipped = [...skipped, ...refused];
        candidates = capable;
      }
      return { candidates, skipped };
    }
    if (decision.candidates.length > 0) return decision;
    if (input.connections.length > 0) return decision;

    const providerId = input.explicitProviderId ?? this.options.defaultProviderId;
    // Named rather than invented: a request for a provider nobody registered should say so, not
    // start building an adapter for it.
    this.options.requireAdapter(providerId);
    const resilience: ResilienceSettings = { ...defaultResilienceSettings };
    return {
      ...decision,
      candidates: [{ providerId, connectionId: `unmanaged:${providerId}`, priority: 0, resilience }],
    };
  }

  /**
   * Refuses a candidate whose connection is over its per-minute limit, or hands it to the limit
   * policy to do so. The *rule* — what a limit means and when it is spent — is `RateLimitPolicy`;
   * this engine's job is only which routes a request may take.
   */
  enforceRateLimit(candidate: RouteCandidate): void {
    this.limits.enforce(candidate);
  }

  /** Credits a connection for a request that was dispatched. */
  recordRequest(connectionId: string): void {
    this.limits.spend(connectionId);
  }
}
