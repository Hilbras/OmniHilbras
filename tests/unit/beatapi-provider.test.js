import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

/**
 * BeatAPI (beatapi.io) — OpenAI-compatible aggregator with a free credit tier.
 *
 * Probed live against the real API: /v1/models, /v1/chat/completions and
 * /v1/usage all answer 401 with a structured error body when the key is
 * invalid, which is how the endpoints were confirmed to exist.
 */
describe("BeatAPI provider", () => {
  const entry = REGISTRY.find((e) => e.id === "beatapi");
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  it("is registered in the freeTier group", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("beatapi");
    expect(entry.aliases).toContain("beat");
  });

  it("points at the verified OpenAI-compatible endpoints", () => {
    expect(PROVIDERS.beatapi.baseUrl).toBe("https://api.beatapi.io/v1/chat/completions");
    expect(PROVIDERS.beatapi.validateUrl).toBe("https://api.beatapi.io/v1/models");
    expect(PROVIDERS.beatapi.format).toBe("openai");
  });

  it("declares no provider-wide thinkingFormat so each model resolves its own", () => {
    // BeatAPI relays to many vendors; a provider-wide thinkingFormat would
    // force one wire format onto models that speak another.
    expect(PROVIDERS.beatapi.thinkingFormat).toBeUndefined();
  });

  it("enables dynamic model discovery and passthrough", () => {
    expect(entry.passthroughModels).toBe(true);
    expect(entry.modelsFetcher).toMatchObject({
      url: "https://api.beatapi.io/v1/models",
      type: "openai",
    });
  });

  it("pins the beatapi-usage flavor for the quota tracker", () => {
    // /v1/usage reports credit_balance + concurrency for the account.
    expect(PROVIDERS.beatapi.usage).toMatchObject({
      apiBase: "https://api.beatapi.io/v1",
      flavor: "beatapi-usage",
    });
    expect(entry.features).toMatchObject({ usage: true, usageApikey: true });
  });

  it("routes through the shared DefaultExecutor", () => {
    const executor = getExecutor("beatapi");
    expect(executor).toBeInstanceOf(DefaultExecutor);
  });

  it("ships a provider icon", () => {
    // getProviderIconSrc() falls back to a text tile when the file is
    // missing, so a missing icon is silent in the UI.
    expect(existsSync(join(REPO_ROOT, "public", "providers", "beatapi.png"))).toBe(true);
  });

  it("is registered in the models resolver so live discovery works", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src", "app", "api", "providers", "[id]", "models", "route.js"),
      "utf8",
    );
    // Without this entry the route answers 400 and discovery silently fails.
    expect(source).toContain("beatapi: createOpenAIModelsConfig(");
    expect(source).toContain("https://api.beatapi.io/v1/models");
  });

  it("is registered in the connection test helper", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src", "app", "api", "providers", "[id]", "test", "testUtils.js"),
      "utf8",
    );
    expect(source).toContain('case "beatapi":');
  });

  it("keeps the registry id unique", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
