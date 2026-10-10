import { RateLimitPolicy } from './rate-limit-policy.js';
import { defaultResilienceSettings, type ConnectionRecord, type ResilienceSettings } from './connections.js';
import { SlidingWindowRateLimiter, resolveRoute, splitProviderPrefix, type RouteCandidate, type RouteDecision } from './routing.js';
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
  /** A provider's strategy. `round-robin` balances all of that provider's connections; absent or `priority` leaves them alone. */
  strategyFor?: (providerId: string) => 'priority' | 'round-robin';
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

  async plan(input: {
    connections: readonly ConnectionRecord[];
    model: string;
    explicitProviderId?: string;
  }): Promise<RouteDecision> {
    // Before anything is read or written. Two maps are keyed by connection id and only ever grew, so a
    // dashboard that deleted a connection kept its wait and its request window for the life of the process.
    // Measured at 2000 and 3000 stale entries respectively.
    this.retain(new Set(input.connections.map((connection) => connection.id)));

    const health = this.options.health.registry();
    const alias = this.options.aliasFor?.(input.model.trim());
    const split = alias ? { model: alias.model, providerId: alias.providerId } : splitProviderPrefix(input.model, input.connections);
    const explicitProviderId = input.explicitProviderId ?? split.providerId;
    const rotation = this.nextBalanceTurn(input.connections);
    const decision = resolveRoute({
      // Copied because `resolveRoute` types its input as mutable while nothing here mutates it.
      // The copy is here rather than at every call site so the looseness is paid for once.
      connections: input.connections.map((connection) => (this.isBalanced(connection) ? { ...connection, balance: true } : connection)),
      model: split.model,
      rotation,
      ...(this.options.familyOf ? { familyOf: this.options.familyOf } : {}),
      ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
      health,
      failureThreshold: this.options.health.getFailureThreshold(),
      // Asked of the limiter, per connection, for this request — see `currentWait`. Passing
      // `this.limits.observed()` here is what bricked a limited connection for the life of the
      // process: the map only ever held the verdict of the last dispatch, and a refused connection
      // produced no further dispatch to correct it.
      rateLimitWaitMs: new Map(
        input.connections.map((connection) => {
          const candidate: RouteCandidate = {
            providerId: connection.providerId,
            connectionId: connection.id,
            priority: connection.priority,
            resilience: connection.resilience,
          };
          return [connection.id, this.currentWait(candidate)] as const;
        }),
      ),
    });
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
