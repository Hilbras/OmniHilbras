import { ProviderError } from '@hilbras/omnihilbras';

/**
 * What a timeout value means, and the deadline that enforces it.
 *
 * The mechanism is three lines — a timer, an abort controller, a `Promise.race`. The policy is
 * everything around it, and until now the policy was scattered across two files: `withDeadline`
 * decided that a non-positive timeout means "no deadline", and `connections.ts` decided what the
 * default is. Two files answering one question is how `defaultResilienceSettings.timeoutMs` came to
 * be `0` while `withDeadline`'s own comment and the SPEC both promised a provider could not hold a
 * request open.
 *
 * ## Why "no deadline" is a real answer and not a missing one
 *
 * `0` is inside `resilienceLimits`, so an operator can ask for no deadline and get one. That is a
 * legitimate choice for a local gateway pointed at a model that legitimately thinks for ten
 * minutes. What is *not* legitimate is it being the default, which is what it was.
 *
 * ## The deadline is enforced here, not delegated
 *
 * The timer rejects the gateway's own promise and aborts the controller, so a provider that ignores
 * its abort signal still cannot hold the request open. Two details are load-bearing and easy to
 * regress:
 *
 * - **The timer is `unref`'d**, so a pending deadline never keeps the process alive on its own.
 * - **The timer is always cleared** in a `finally`, and the caller's abort listener is always
 *   removed. A gateway that leaks one timer per request looks fine in a test and falls over in a
 *   day of real traffic.
 */

/** The value that asks for no deadline at all. Inside `resilienceLimits`, so it is a real choice. */
export const NO_DEADLINE = 0;

/**
 * The two minutes a connection gets when it does not ask for something else.
 *
 * Long enough for a large-context reasoning turn, short enough that a provider which has stopped
 * answering is reported rather than waited on. It was `0` — that is, *no deadline* — which is what
 * let a hung provider hold a request open indefinitely while the code claimed otherwise.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

export type DeadlineOptions = {
  /** The connection's timeout. Non-positive means no deadline. */
  timeoutMs: number;
  providerId: string;
  /** The caller's signal, already wired to the client disconnecting. */
  signal?: AbortSignal;
};

export class TimeoutPolicy {
  /**
   * Whether this timeout is a deadline at all.
   *
   * Asked rather than inlined, because "0 means unlimited" is the decision that was duplicated.
   */
  static enforces(timeoutMs: number): boolean {
    return timeoutMs > NO_DEADLINE;
  }

  /** The error a missed deadline raises. Retryable: another connection may be quicker. */
  timeoutError(timeoutMs: number, providerId: string): ProviderError {
    return new ProviderError('PROVIDER_TIMEOUT', `The provider did not respond within ${timeoutMs} ms.`, { providerId, retryable: true });
  }

  /**
   * Runs `run` under a deadline, or straight through when there is none.
   *
   * A caller who has already cancelled gets no deadline of its own — it would fire later for a
   * request nobody is waiting for — and the cancellation is passed down so the provider sees it.
   */
  async within<T>(options: DeadlineOptions, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    const { timeoutMs, providerId, signal } = options;
    if (!TimeoutPolicy.enforces(timeoutMs)) return run(signal);
    // A deadline on a request the caller has abandoned is a timer that will fire into nothing.
    if (signal?.aborted) return run(signal);

    const controller = new AbortController();
    // The caller's cancellation has to reach the provider, not just this promise, or an abort
    // would stop the gateway waiting while the provider call kept running.
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(this.timeoutError(timeoutMs, providerId));
      }, timeoutMs);
      // Without this, a pending deadline is a reason for the process to stay alive.
      timer.unref?.();
    });

    try {
      return await Promise.race([run(controller.signal), deadline]);
    } finally {
      // Both of these are load-bearing. A gateway that leaks one timer per request survives its
      // tests and falls over in a day of traffic.
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
