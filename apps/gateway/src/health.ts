import { ProviderError, type ProviderAdapter, type ProviderHealth, type ProviderRequestContext } from '@hilbras/omnihilbras';
// The registry lives with routing rather than in the SDK, because it exists to answer one
// question: "who is ejected?". It is read by `resolveRoute` and written here, and the two are
// deliberately the same object so a failure recorded by a request and a failure recorded by a
// sweep cannot disagree.
import { HealthRegistry } from './routing.js';

/**
 * Health, as its own concern.
 *
 * Extracted from `GatewayService` because health is a **cross-cutting** concern that had ended up
 * as one of nine things the service was simultaneously responsible for, and because a health check
 * that is entangled with routing is a health check that can only be tested by running routing.
 *
 * The boundary is two questions and nothing else: *which adapters exist*, and *what context does
 * this adapter need to be asked*. Both are supplied by the service as closures, so this file has
 * no knowledge of connections, OAuth, or model discovery — and can be exercised without any of it.
 *
 * ## Three things this had wrong once, kept here so they are not re-learned
 *
 * **A sweep per request.** `GET /health` used to call `refreshHealth()` every time, probing
 * thirteen providers on each call — 8.45 s, each probe a real request to somebody's API. Worse,
 * the browser allows six connections per origin and the page asks for health on load, so a sweep
 * that outlived the poll interval queued the next behind it: health requests monopolised the pool
 * and ordinary requests queued behind *them*. A chat turn that answers in six seconds took over a
 * minute, which is indistinguishable from a model that hangs. The report is now served from the
 * last sweep, and `checkedAt` is reported so its age is visible rather than implied.
 *
 * **A check that proved nothing.** DeepSeek Web's check reported `healthy` from a cached
 * credential, so it looked like a successful check because something was returned. A health check
 * has to ask now; the cache is for the request path.
 *
 * **A verdict with no reason.** Four adapters reported `unavailable` from a bare `catch {}` with
 * no message, so the dashboard could not say whether the key was rejected, the endpoint was wrong,
 * or the provider was down. Three different fixes, one indistinguishable answer. The contract test
 * for this is in the SDK; the reason is required here too, because a manager that accepts a
 * reasonless verdict will keep producing them.
 */

export type GatewayProviderHealth = ProviderHealth & {
  providerId: string;
};

export type HealthReport = {
  status: 'ok' | 'degraded';
  checkedAt: string;
  providers: GatewayProviderHealth[];
};

/**
 * What a health check needs from the rest of the gateway.
 *
 * Deliberately the smallest thing that works. Passing the service itself would have made the
 * extraction cosmetic; passing these two questions makes the manager testable in isolation and
 * makes the coupling visible — if health ever needs a third thing from the gateway, that is the
 * signal that a boundary is wrong rather than a reason to widen this interface.
 */
export type HealthProbeSource = {
  /** Adapters that can actually serve traffic right now. */
  adapters(signal?: AbortSignal): Promise<ProviderAdapter[]>;
  /** The request context an adapter should be asked in, carrying its credential. */
  contextFor(adapterId: string, signal?: AbortSignal): Promise<ProviderRequestContext>;
  /**
   * Whether the stored credential is already known to have expired, without a request.
   *
   * Optional so an embedder that does not track credential expiry is unaffected, and *only* ever
   * used to skip a probe that cannot succeed. A provider's own health check still runs whenever the
   * answer is not already known, because a credential that is not expired may still have been
   * revoked.
   */
  credentialStanding?(adapterId: string, signal?: AbortSignal): Promise<{ state: 'expired' | 'valid' | 'unknown' }>;
};

const defaultHealthIntervalMs = 60_000;
const defaultFailureThreshold = 3;

export class HealthManager {
  private readonly registry: HealthRegistry;
  private intervalMs: number;
  private failureThreshold: number;
  private timer?: ReturnType<typeof setInterval>;
  /** The most recent sweep, served to every `GET /health` until the next one lands. */
  private lastHealth: HealthReport | undefined;
  /** The sweep in flight, so concurrent callers share one rather than each starting one. */
  private inFlight: Promise<HealthReport> | undefined;

  constructor(
    private readonly source: HealthProbeSource,
    options: { now?: () => number; recoveryCooldownMs?: number; intervalMs?: number; failureThreshold?: number } = {},
  ) {
    this.registry = new HealthRegistry(options.now ?? (() => Date.now()), options.recoveryCooldownMs);
    this.intervalMs = options.intervalMs ?? defaultHealthIntervalMs;
    this.failureThreshold = options.failureThreshold ?? defaultFailureThreshold;
  }

  setFailureThreshold(threshold: number) {
    this.failureThreshold = threshold;
  }

  getFailureThreshold() {
    return this.failureThreshold;
  }

  /** How often background polling runs. 0 keeps it off. */
  setInterval(intervalMs: number) {
    this.intervalMs = intervalMs;
    if (this.timer) this.start();
  }

  /** Starts polling so routing reflects reality without waiting for a request. */
  start(intervalMs = this.intervalMs) {
    this.stop();
    this.intervalMs = intervalMs;
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.refresh();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Records a success or failure for the ejection counters, for callers outside a sweep. */
  recordSuccess(providerId: string, latencyMs: number, checkedAt: string) {
    this.registry.recordSuccess(providerId, latencyMs, checkedAt);
  }

  recordFailure(providerId: string, code: string, message: string) {
    this.registry.recordFailure(providerId, code, message);
  }

  /** Routing's view of a provider's health, or undefined when it has never been checked. */
  snapshot(providerId: string) {
    return this.registry.snapshot(providerId, this.failureThreshold);
  }

  /**
   * The registry itself, for `resolveRoute`.
   *
   * Routing reads failure counts to decide who is ejected and should not have to know that the
   * counters live here. Exposing the registry rather than new counting methods keeps
   * `resolveRoute`'s provider-agnostic signature unchanged, and keeps this the single owner of
   * the counters.
   */
  snapshotRegistry() {
    return this.registry;
  }

  /**
   * Polls every active adapter and folds the result into routing state.
   *
   * Stores the result, and shares an in-flight sweep between concurrent callers: without the
   * sharing, a page reload and the background timer landing together would each start their own
   * thirteen probes.
   */
  refresh(signal?: AbortSignal): Promise<HealthReport> {
    if (!this.inFlight) {
      this.inFlight = this.sweep(signal).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async sweep(signal?: AbortSignal): Promise<HealthReport> {
    const adapters = await this.source.adapters(signal);
    const providers = await Promise.all(adapters.map((adapter) => this.probe(adapter, signal)));
    const report: HealthReport = {
      status: providers.some((provider) => provider.status !== 'healthy') ? 'degraded' : 'ok',
      checkedAt: new Date().toISOString(),
      providers,
    };
    this.lastHealth = report;
    return report;
  }

  /**
   * The report, from the last sweep rather than a new one.
   *
   * A background sweep already runs every 60 s, so the freshest honest answer is almost always at
   * most that old — and the caller is told when, rather than being handed something that implies
   * it was just measured.
   */
  report(signal?: AbortSignal): Promise<HealthReport> {
    if (this.lastHealth) return Promise.resolve(this.lastHealth);
    return this.refresh(signal);
  }

  /**
   * Health for one provider, without the cost of the whole sweep.
   *
   * A provider that is not in the active set is named in the error rather than reported
   * unhealthy: "no such provider" and "this provider is down" are different problems, and the
   * second sends the user to fix a credential that was never the issue.
   */
  async forProvider(providerId: string, signal?: AbortSignal): Promise<GatewayProviderHealth> {
    const adapters = await this.source.adapters(signal);
    const adapter = adapters.find((item) => item.id === providerId);
    if (!adapter) {
      const message = `OmniHilbras has no active connection for ${providerId}. Connect it first, then test it.`;
      throw new ProviderError('NOT_FOUND', message, { providerId, publicMessage: message });
    }
    return this.probe(adapter, signal);
  }

  /**
   * Asks one adapter, and records the outcome.
   *
   * `unavailable` returned by an adapter is recorded as a **failure** rather than a success.
   * Recording it as success made routing report a healthy provider with zero failures while
   * `/health` said unavailable, and it corrupted the very counting that drives ejection.
   */
  private async probe(adapter: ProviderAdapter, signal?: AbortSignal): Promise<GatewayProviderHealth> {
    // Asked before anything is spent. A ChatGPT Web check launches a browser, and this is the one
    // question whose answer is already written down in the credential.
    if (this.source.credentialStanding) {
      const standing = await this.source.credentialStanding(adapter.id, signal);
      if (standing.state === 'expired') {
        const message = 'This connection’s session has expired. Sign in again.';
        return { providerId: adapter.id, status: 'unavailable', checkedAt: new Date().toISOString(), message };
      }
    }
    if (!adapter.healthCheck) {
      return { providerId: adapter.id, status: 'unavailable', checkedAt: new Date().toISOString(), message: 'Health checks are not supported.' };
    }
    const startedAt = Date.now();
    try {
      const context = await this.source.contextFor(adapter.id, signal);
      const health = await adapter.healthCheck(context);
      if (health.status === 'unavailable') {
        /**
         * A verdict without a reason is a guess wearing a status.
         *
         * Four adapters shipped exactly that — a bare `catch {}` reporting `unavailable` with
         * nothing attached — so the dashboard could not say whether the key was rejected, the
         * endpoint was wrong, or the provider was down. Three different fixes, one
         * indistinguishable answer.
         *
         * The provider contract now catches that at build time, but a manager that merely passes
         * the omission along will keep producing it for anything the contract does not cover. The
         * boundary fills the gap so the shape cannot be wrong, rather than trusting nine call
         * sites to each remember.
         */
        const message = health.message?.trim() || `${adapter.name} reported itself unavailable without saying why.`;
        this.registry.recordFailure(adapter.id, 'PROVIDER_UNAVAILABLE', message);
        return { ...health, providerId: adapter.id, message };
      }
      this.registry.recordSuccess(adapter.id, health.latencyMs ?? Date.now() - startedAt, health.checkedAt);
      return { providerId: adapter.id, latencyMs: Date.now() - startedAt, ...health };
    } catch (error) {
      this.registry.recordFailure(adapter.id, 'PROVIDER_UNAVAILABLE', 'The provider health check failed.');
      return {
        providerId: adapter.id,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        // The underlying reason, because "The provider health check failed" points the user at the
        // provider when the cause was their own connection.
        message: error instanceof Error ? error.message : 'The provider health check failed.',
      };
    }
  }
}
