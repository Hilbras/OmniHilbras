import { describe, expect, it, beforeEach } from "vitest";

import {
  getCapabilitiesForModel,
  setCatalogSource,
  clearCapabilitiesCache,
} from "../../open-sse/providers/capabilities.js";

/**
 * The memoised capability lookup.
 *
 * Resolving a model's capabilities is a pure function of (provider, model)
 * plus the catalog overlay, and it is the largest CPU item on the request
 * path — 84 % of the catalogue misses the exact tables and falls through to a
 * 111-pattern scan.
 *
 * The memo must be *correct* first: a stale answer would send the wrong
 * thinking format to a model and break the request.
 */
describe("capability memoisation", () => {
  beforeEach(() => {
    clearCapabilitiesCache();
    setCatalogSource(null);
  });

  it("gives the same answer as a cold lookup", () => {
    const first = getCapabilitiesForModel("openrouter", "anthropic/claude-sonnet-4.5");
    const second = getCapabilitiesForModel("openrouter", "anthropic/claude-sonnet-4.5");
    expect(second).toEqual(first);
  });

  it("does not hand out a shared object a caller could mutate", () => {
    const first = getCapabilitiesForModel("openrouter", "anthropic/claude-sonnet-4.5");
    const before = first.contextWindow;
    first.contextWindow = 1;
    const second = getCapabilitiesForModel("openrouter", "anthropic/claude-sonnet-4.5");
    expect(second.contextWindow).toBe(before);
  });

  it("keys by provider as well as model", () => {
    // The same model id under two providers can have different limits.
    const a = getCapabilitiesForModel("provider-a", "shared-model");
    const b = getCapabilitiesForModel("provider-b", "shared-model");
    expect(a).toEqual(b); // same model, no provider-specific override → same answer
    expect(getCapabilitiesForModel("provider-a", "other-model")).toBeTruthy();
  });

  it("re-resolves after the catalog source is replaced", () => {
    const before = getCapabilitiesForModel("openrouter", "some/model");
    expect(before).toBeTruthy();

    // A catalog that claims a bigger window must win.
    setCatalogSource({
      getModalities: () => null,
      getLimits: () => ({ contextWindow: 999999, maxOutput: 4242 }),
    });

    const after = getCapabilitiesForModel("openrouter", "some/model");
    expect(after.contextWindow).toBe(999999);
    expect(after.maxOutput).toBe(4242);
  });

  it("answers a model with no id without caching nonsense", () => {
    const caps = getCapabilitiesForModel("openrouter", "");
    expect(caps).toBeTruthy();
    expect(typeof caps.contextWindow).toBe("number");
  });
});
