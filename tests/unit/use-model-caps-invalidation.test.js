// The model-caps cache lives for the whole session, so its invalidation must
// not depend on a mounted consumer: a "customModelChanged" event has to drop
// the cache and start a fresh fetch, even while a request is still in flight.
import { describe, it, expect, afterEach, vi } from "vitest";

async function loadModule(fetchImpl) {
  vi.resetModules();
  const listeners = new Map();
  vi.stubGlobal("window", {
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener: () => {},
  });
  vi.stubGlobal("fetch", fetchImpl);
  await import("@/shared/hooks/useModelCaps.js");
  return listeners;
}

function fire(listeners, type) {
  for (const handler of listeners.get(type) || []) handler();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("useModelCaps cache invalidation", () => {
  it("forces a fresh fetch instead of reusing the in-flight request", async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {})); // never settles
    const listeners = await loadModule(fetchImpl);

    fire(listeners, "customModelChanged");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The first request is still in flight — the invalidation must not hand
    // its promise out again.
    fire(listeners, "customModelChanged");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("drops the cached capabilities on every invalidation", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [] }),
    }));
    const listeners = await loadModule(fetchImpl);

    fire(listeners, "customModelChanged");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // The first answer is in the cache now.
    await Promise.resolve();

    fire(listeners, "customModelChanged");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("invalidates without a mounted consumer", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [] }),
    }));
    const listeners = await loadModule(fetchImpl);

    // No useModelCaps() is mounted — the cache still has to go.
    fire(listeners, "customModelChanged");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
