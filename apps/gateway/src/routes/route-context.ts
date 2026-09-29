import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';
import type { GatewayServerOptions } from '../server.js';
import type { GatewayService } from '../service.js';
import type { AuthContext } from '../runtime.js';

/**
 * What a route handler is given.
 *
 * Every route in the old `handleRequest` closed over the same six values, and each one is a
 * parameter of the 373-line function rather than anything a handler could obtain for itself. Naming
 * them here is what lets a route be a function that takes one argument — which is what makes the
 * handler signature `Promise<boolean>` mean something: *true* if this route consumed the request.
 *
 * `signal` is the request's abort signal, already wired to both the client's disconnect and the
 * response closing. Handlers never build their own, so a route cannot accidentally outlive the
 * connection that asked for it.
 *
 * `trusted` is true only for a request from an allowlisted dashboard origin. It gates the
 * authenticated LLM surface and nothing else, and it lives in the context rather than being
 * re-derived per route so that "who is this from" has exactly one answer in the system.
 */
export type RouteContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  service: GatewayService;
  options: GatewayServerOptions;
  /** Echoed back as `Access-Control-Allow-Origin`, and `undefined` for a non-browser caller. */
  origin: string | undefined;
  signal: AbortSignal;
  /**
   * Who is asking, rather than a flag saying whether they may.
   *
   * This was `trusted: boolean`, which is a real and correct decision expressed as a value with no
   * owner and no name — so nothing above the HTTP layer could ask *who*, and a hosted gateway could
   * not answer "may this call the LLM surface without a key" any differently from a loopback one.
   * It is derived once, where the request is understood, and everything else asks.
   */
  auth: AuthContext;
};

/** A route handler. Returns true when it consumed the request. */
export type RouteHandler = (ctx: RouteContext) => Promise<boolean>;
