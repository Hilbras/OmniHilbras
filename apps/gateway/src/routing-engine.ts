import { RateLimitPolicy } from './rate-limit-policy.js';
import { defaultResilienceSettings, type ConnectionRecord, type ResilienceSettings } from './connections.js';
import { SlidingWindowRateLimiter, resolveRoute, type RouteCandidate, type RouteDecision } from './routing.js';
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

  constructor(private readonly options: RoutingEngineOptions) {
    this.limits = new RateLimitPolicy({ limiter: options.rateLimiter });
  }

  /** The wait each connection was last told to observe, keyed by connection id. */
  waits(): ReadonlyMap<string, number> {
    return this.limits.observed();
  }

  /**
   * The ordered candidates for a request, or a decision with the reasons each was skipped.
   *
   * "Unmanaged" is a last resort, not a fallback: it applies only when there are no connections at
   * all. With connections present and every one skipped, the decision is returned as-is, because
   * *why* they were skipped is the answer the operator needs.
   */
  async plan(input: {
    connections: readonly ConnectionRecord[];
    model: string;
    explicitProviderId?: string;
  }): Promise<RouteDecision> {
    const decision = resolveRoute({
      // Copied because `resolveRoute` types its input as mutable while nothing here mutates it.
      // The copy is here rather than at every call site so the looseness is paid for once.
      connections: [...input.connections],
      model: input.model,
      ...(input.explicitProviderId === undefined ? {} : { explicitProviderId: input.explicitProviderId }),
      health: this.options.health.registry(),
      failureThreshold: this.options.health.getFailureThreshold(),
      rateLimitWaitMs: new Map(this.limits.observed()),
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
