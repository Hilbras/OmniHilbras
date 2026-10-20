import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

/**
 * The free-tier aggregators that were added without the two integration
 * points every other provider has: the /models resolver (live catalogue
 * discovery) and the connection test helper (key validation). Without them
 * "fetch models" and "test connection" silently fail.
 *
 * Every endpoint here was probed live with a real key: each /v1/models
 * answered 200 with the full catalogue.
 */
const AGGREGATORS = [
  {
    id: "nara-router",
    modelsUrl: "https://router.bynara.id/v1/models",
    baseUrl: "https://router.bynara.id/v1/chat/completions",
    // Confirmed live: 45 models, each carrying context_window + vision/reasoning.
    contextField: "context_window",
  },
  {
    id: "apmix",
    modelsUrl: "https://api.apmix.ai/v1/models",
    baseUrl: "https://api.apmix.ai/v1/chat/completions",
  },
  {
    id: "apinex",
    modelsUrl: "https://api.apinex.bond/v1/models",
    baseUrl: "https://api.apinex.bond/v1/chat/completions",
  },
  {
    id: "tiarina",
    modelsUrl: "https://ai.tiarina.cloud/v1/models",
    baseUrl: "https://ai.tiarina.cloud/v1/chat/completions",
  },
  {
    id: "xkiro",
    modelsUrl: "https://api.xkiro.com/v1/models",
    baseUrl: "https://api.xkiro.com/v1/chat/completions",
    // Confirmed live: 108 models, each carrying context_length + max_output_tokens.
    contextField: "context_length",
  },
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODELS_ROUTE = join(REPO_ROOT, "src", "app", "api", "providers", "[id]", "models", "route.js");
const TEST_UTILS = join(REPO_ROOT, "src", "app", "api", "providers", "[id]", "test", "testUtils.js");

describe("free-tier aggregators: models discovery + connection test", () => {
  const modelsSource = readFileSync(MODELS_ROUTE, "utf8");
  const testSource = readFileSync(TEST_UTILS, "utf8");

  for (const p of AGGREGATORS) {
    it(`${p.id} is registered in the /models resolver`, () => {
      // Without an entry the route answers 400 "Provider X does not support
      // models listing" and live discovery never runs.
      // Ids with a dash are quoted keys in the resolver ("nara-router": ...).
      const prefix = `${p.id}: createOpenAIModelsConfig(`;
      const quotedPrefix = `"${p.id}": createOpenAIModelsConfig(`;
      expect(
        modelsSource.includes(prefix) || modelsSource.includes(quotedPrefix),
        `no models entry for ${p.id}`,
      ).toBe(true);
      const line = modelsSource
        .split("\n")
        .find((l) => l.trim().startsWith(prefix) || l.trim().startsWith(quotedPrefix));
      expect(line, `no models entry for ${p.id}`).toBeTruthy();
      expect(line).toContain(p.modelsUrl);
    });

    it(`${p.id} is registered in the connection test helper`, () => {
      // Otherwise "test connection" falls through to a generic probe and
      // reports the key as invalid.
      expect(testSource).toContain(`case "${p.id}":`);
    });

    it(`${p.id} points at the probed base + models URLs`, () => {
      expect(PROVIDERS[p.id].baseUrl).toBe(p.baseUrl);
      expect(PROVIDERS[p.id].validateUrl).toBe(p.modelsUrl);
      expect(PROVIDERS[p.id].format).toBe("openai");
    });

    it(`${p.id} enables live discovery + passthrough`, () => {
      const entry = REGISTRY.find((e) => e.id === p.id);
      expect(entry.passthroughModels).toBe(true);
      expect(entry.modelsFetcher).toMatchObject({ url: p.modelsUrl, type: "openai" });
    });
  }

  it("keeps every registry id unique", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("aggregator usage flavors", () => {
  it("apinex pins the balance flavor and xkiro pins the usage flavor", () => {
    // Both were confirmed live with a real key; pinning keeps the adapter
    // from probing endpoints the host does not have.
    expect(PROVIDERS.apinex.usage).toMatchObject({
      apiBase: "https://api.apinex.bond/v1",
      flavor: "apinex-balance",
    });
    expect(PROVIDERS.xkiro.usage).toMatchObject({
      apiBase: "https://api.xkiro.com/v1",
      flavor: "xkiro-usage",
    });
  });

  it("leaves nara-router and tiarina unpinned — they expose no usage API", () => {
    // Probed live: /usage, /balance, /limits, /api/user/self all 404 on both.
    // The adapter falls back to the local-history rows for them.
    expect(PROVIDERS["nara-router"].usage.flavor).toBeUndefined();
    expect(PROVIDERS.tiarina.usage.flavor).toBeUndefined();
  });

  it("leaves apmix unpinned until a key confirms its /v1/usage shape", () => {
    // The endpoint answers 401 on an invalid key (so it exists), but the
    // success shape could not be confirmed without a key, so it is not pinned.
    expect(PROVIDERS.apmix.usage.apiBase).toBe("https://api.apmix.ai/v1");
    expect(PROVIDERS.apmix.usage.flavor).toBeUndefined();
  });
});
