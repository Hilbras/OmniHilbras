import { ProviderError, type ProviderRequestContext } from '@hilbras/omnihilbras';

/**
 * One request's identity, from the edge to whichever provider answered it.
 *
 * ## Why this exists, when the SDK already has a `ProviderRequestContext`
 *
 * Because `ProviderRequestContext` has carried a `requestId` field since it was written, and
 * **nothing has ever set it.** Measured across the whole repository, the only `requestId` is a local
 * variable inside the ChatGPT Web browser driver, which never reaches an adapter. So the one field
 * that makes a request context worth having — the thing that lets a user quote *"it failed at 3pm,
 * request 4f2a"* and an operator find that line — was declared and always `undefined`.
 *
 * That is the whole of the finding. Tying four fields into one tidier type would have changed
 * nothing; making the id real changes what a failure report is worth.
 *
 * ## What it is for
 *
 * Not telemetry, and not a trace. Three concrete uses, each of which is currently impossible:
 *
 * 1. **A client can quote it.** A refusal arrives carrying the id, so *"it said no, here is
 *    4f2a"* is a sentence a user can write down and an operator can search for.
 * 2. **The attempt ledger can be tied to it.** A client that sees four attempts knows four requests
 *    were paid for; today it cannot say which request they belonged to.
 * 3. **A provider's own words stay attached to the request that drew them.** The dashboard and the
 *    log line refer to the same thing instead of to the same *minute*.
 *
 * ## Why the id is generated at the edge
 *
 * One place, once, before any routing. A context that acquired its id inside a provider adapter
 * would be an id per provider rather than per request, which is the opposite of what it is for.
 */

/**
 * The request scope the gateway creates for each request it accepts.
 *
 * Immutable, and frozen rather than merely `readonly`. `readonly` is a *type* annotation and
 * nothing at runtime; a test that asserted immutability and found the object writable is the
 * second time this session that distinction has cost something — the first was a `ReadonlyMap` that
 * was a real `Map`. A mutable scope is a thing one part of the system can change for another, and
 * an id that changes after the client was told it is worse than no id.
 */
export type RequestScope = {
  /** Opaque, stable for the life of the request, and safe to show a user. */
  readonly id: string;
  /** When the gateway accepted the request, so a report can be placed in time without guessing. */
  readonly startedAt: number;
  /** The model the client asked for, before any provider was chosen. */
  readonly requestedModel: string;
  /** The provider the client pinned, if it pinned one. */
  readonly explicitProviderId?: string;
};

/**
 * Creates a scope for a request.
 *
 * The id is a random UUID with its dashes removed — the same shape a sign-in session id uses, so an
 * id in a log line is recognisably an id and cannot be confused with a model name, a provider name
 * or a connection id. It is not a counter, because a counter is guessable and these appear in
 * client-visible output.
 */
export function startRequestScope(input: { requestedModel: string; explicitProviderId?: string; id?: string }): RequestScope {
  return Object.freeze({
    id: input.id ?? crypto.randomUUID().replace(/-/g, ''),
    startedAt: Date.now(),
    requestedModel: input.requestedModel,
    ...(input.explicitProviderId === undefined ? {} : { explicitProviderId: input.explicitProviderId }),
  });
}

/**
 * Puts a request's identity onto the context an adapter will see.
 *
 * `ProviderRequestContext` is the SDK's type and the adapter boundary is a published API, so the id
 * travels on the field that already exists for it rather than on something new. An adapter that
 * ignores it is unaffected.
 */
export function withRequestScope(context: ProviderRequestContext, scope: RequestScope): ProviderRequestContext {
  return { ...context, requestId: scope.id };
}

/**
 * Puts a request's id on an error that is about to be reported, without changing its code.
 *
 * The code is left alone on purpose. A `ProviderError`'s classification is what the routing engine
 * reads, and a caller that has already decided the request is over does not need a reclassification
 * because a diagnostic was attached. Only `details` grows, which is where diagnostic material
 * already lives and which the envelope already knows how to read.
 *
 * Returns the error unchanged when it is not a `ProviderError` or already carries this request's
 * id, so attaching twice is harmless and attaching to the wrong request cannot happen.
 */
export function attachRequestId(error: unknown, scope: RequestScope): unknown {
  if (!(error instanceof ProviderError)) return error;
  const details = (error.details ?? {}) as Record<string, unknown>;
  /**
   * Any existing id is left alone, not just this request's.
   *
   * A second, *different* id means two requests claimed one error, which is an upstream mistake.
   * Silently replacing the first would point the error at a request that was never in flight, and a
   * wrong id is worse than no id: it sends an operator to a conversation that had nothing to do
   * with the failure.
   */
  if (typeof details.requestId === 'string') return error;
  return new ProviderError(error.code, error.message, {
    ...(error.providerId ? { providerId: error.providerId } : {}),
    ...(error.statusCode ? { statusCode: error.statusCode } : {}),
    ...(error.retryable ? { retryable: true } : {}),
    ...(error.publicMessage ? { publicMessage: error.publicMessage } : {}),
    details: { ...details, requestId: scope.id },
    cause: error,
  });
}
