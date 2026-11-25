/**
 * What a route is allowed to do, stated once.
 *
 * Authentication, billing and inbound throttling used to be three separate path lists. A route
 * added to one and not the others was still reachable, still spent money, and still escaped the
 * ceiling — the failure was invisible because every individual list was internally consistent.
 * This file is the one table those decisions read.
 */

/** A call that can spend a provider's allowance, or make an outbound request on the caller's behalf. */
const BILLABLE_POST_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/embeddings',
  '/v1/images/generations',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
  '/v1/systemone',
  '/v1/fetch',
  '/v1/search',
]);

const VIDEO_GENERATION_PATHS = new Set([
  '/v1/videos/generations',
  '/v1/videos/edits',
  '/v1/videos/extensions',
]);

/**
 * Whether this request consumes a provider allowance or external egress.
 *
 * Video polls are reads of a job that was already created, and token counting is an estimate:
 * neither is billable here. Video creation is.
 */
export function isBillableRoute(method: string | undefined, pathname: string): boolean {
  if (method !== 'POST') return false;
  return BILLABLE_POST_PATHS.has(pathname) || VIDEO_GENERATION_PATHS.has(pathname);
}