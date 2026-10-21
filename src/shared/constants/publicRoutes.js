/**
 * The root paths that reach the LLM API.
 *
 * These are the paths an AI agent talks to: `/v1/chat/completions`,
 * `/responses`, `/systemone`, … They are rewritten to `/api/v1/…` by
 * `next.config.mjs`, and the dashboard guard must recognise the *same* set as
 * public — the middleware sees the pre-rewrite path.
 *
 * They live in one place because the two lists used to drift: `/systemone`
 * was rewritten to a public LLM route but was missing from the guard's public
 * prefixes, so it fell through the middleware with no key check at all. The
 * guard's deny-by-default rule is the safety net, and a path the guard does
 * not know about is a path the net does not cover.
 *
 * The rewrites and the prefixes are both derived from the same table, and a
 * test asserts they agree.
 */

/** The rewrites that map a public root path onto the LLM API. */
export const PUBLIC_LLM_REWRITES = [
  { source: "/v1/v1/:path*", destination: "/api/v1/:path*" },
  { source: "/v1/v1", destination: "/api/v1" },
  { source: "/codex/:path*", destination: "/api/v1/responses" },
  { source: "/responses", destination: "/api/v1/responses" },
  { source: "/systemone", destination: "/api/v1/systemone" },
  { source: "/v1beta/:path*", destination: "/api/v1beta/:path*" },
  { source: "/v1beta", destination: "/api/v1beta" },
  { source: "/v1/:path*", destination: "/api/v1/:path*" },
  { source: "/v1", destination: "/api/v1" },
];

/**
 * The prefixes the dashboard guard treats as public (no dashboard session).
 *
 * Derived from the rewrite sources — the first path segment of each — plus the
 * API paths the rewrites point at, so a request that arrives *after* the
 * rewrite is covered too.
 */
export const PUBLIC_LLM_PREFIXES = [
  ...new Set([
    ...PUBLIC_LLM_REWRITES.map((r) => `/${r.source.split("/")[1]}`),
    "/api/v1",
    "/api/v1beta",
  ]),
].sort();
