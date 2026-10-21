import { describe, expect, it } from "vitest";

import { PUBLIC_LLM_PREFIXES, PUBLIC_LLM_REWRITES } from "@/shared/constants/publicRoutes";

/**
 * The public LLM routes must be the same set in the two places that care:
 *
 *  - `next.config.mjs` rewrites them onto `/api/v1/…`
 *  - `src/dashboardGuard.js` treats them as public, so the middleware does
 *    not demand a dashboard session for them
 *
 * They used to be two hand-written lists, and they drifted: `/systemone` was
 * rewritten to a public LLM route but was missing from the guard's list, so
 * it fell through the middleware with no key check. The guard's rule is
 * deny-by-default, and a path it does not know about is a path the net does
 * not cover.
 */
describe("public LLM routes", () => {
  it("covers every rewritten path in the guard's public prefixes", () => {
    for (const rewrite of PUBLIC_LLM_REWRITES) {
      const firstSegment = `/${rewrite.source.split("/")[1]}`;
      expect(
        PUBLIC_LLM_PREFIXES,
        `${rewrite.source} is rewritten to ${rewrite.destination} but the guard does not treat it as public`,
      ).toContain(firstSegment);
    }
  });

  it("covers the API paths the rewrites point at", () => {
    // A request that arrives after the rewrite must be recognised too.
    for (const prefix of ["/api/v1", "/api/v1beta"]) {
      expect(PUBLIC_LLM_PREFIXES).toContain(prefix);
    }
  });

  it("includes /systemone, the path that drifted", () => {
    expect(PUBLIC_LLM_PREFIXES).toContain("/systemone");
  });

  it("does not expose a dashboard path as public", () => {
    // The public list is for the LLM API only — a management route that
    // appeared here would skip the session check.
    for (const prefix of PUBLIC_LLM_PREFIXES) {
      expect(prefix.startsWith("/api/settings")).toBe(false);
      expect(prefix.startsWith("/api/keys")).toBe(false);
      expect(prefix.startsWith("/api/providers")).toBe(false);
    }
  });
});
