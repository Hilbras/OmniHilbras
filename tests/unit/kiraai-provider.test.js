import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { getImageAdapter } from "../../open-sse/handlers/imageProviders/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("KiraAI provider", () => {
  const entry = REGISTRY.find((e) => e.id === "kiraai");

  it("is registered as an OpenAI-compatible apikey provider (freeTier category)", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("kiraai");
    expect(entry.aliases).toContain("kira");
    expect(entry.authModes).toEqual(["apikey"]);
  });

  it("points at the verified OpenAI-compatible base URL", () => {
    expect(PROVIDERS.kiraai.baseUrl).toBe("https://kiraai.vn/api/v1/chat/completions");
    expect(PROVIDERS.kiraai.validateUrl).toBe("https://kiraai.vn/api/v1/models");
    expect(PROVIDERS.kiraai.format).toBe("openai");
  });

  it("declares no provider-wide thinkingFormat so each model resolves its own", () => {
    expect(PROVIDERS.kiraai.thinkingFormat).toBeUndefined();
  });

  it("fetches its live catalogue but does not pass unknown ids through", () => {
    // /models is authoritative, so an id it does not list is rejected here
    // instead of being forwarded upstream.
    expect(entry.modelsFetcher).toMatchObject({
      url: "https://kiraai.vn/api/v1/models",
      type: "openai",
    });
    expect(entry.passthroughModels).toBeUndefined();
  });

  it("exposes a small seed of bare (unprefixed) ids covering chat and media", () => {
    const models = PROVIDER_MODELS.kiraai || [];
    const ids = models.map((m) => m.id);
    expect(ids).toContain("kira-3.5-pro");
    expect(ids).toContain("kira-mini-1.0");
    expect(ids.every((id) => !id.includes("/"))).toBe(true);
    expect(isMedia(models, "image")).toBe(true);
    expect(isMedia(models, "tts")).toBe(true);
  });

  it("declares image and tts media endpoints for the generic adapters", () => {
    expect(entry.serviceKinds).toEqual(["llm", "image", "tts"]);
    expect(PROVIDER_MEDIA.kiraai?.imageConfig?.baseUrl).toBe(
      "https://kiraai.vn/api/v1/images/generations"
    );
    expect(PROVIDER_MEDIA.kiraai?.ttsConfig).toMatchObject({
      baseUrl: "https://kiraai.vn/api/v1/audio/speech",
      authType: "apikey",
      authHeader: "bearer",
      format: "openai",
    });
    expect(getImageAdapter("kiraai")).not.toBeNull();
  });

  it("routes through the shared DefaultExecutor (no custom adapter)", () => {
    expect(getExecutor("kiraai")).toBeInstanceOf(DefaultExecutor);
    // No provider-specific executor file may be picked up by id.
    expect(getExecutor("kiraai").constructor.name).toBe(DefaultExecutor.name);
  });

  it("resolves per-model capabilities from the shared tables", () => {
    expect(getCapabilitiesForModel("kiraai", "claude-sonnet-5.5")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
    });
    expect(getCapabilitiesForModel("kiraai", "gpt-6-sol")).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai",
    });
  });

  it("does not invent capabilities for an uncatalogued model", () => {
    const caps = getCapabilitiesForModel("kiraai", "some-unknown-model-x");
    expect(caps.vision).toBe(false);
    expect(caps.reasoning).toBe(false);
    expect(caps.thinkingFormat).toBeNull();
  });

  it("keeps every registry id unique after adding kiraai", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function isMedia(models, kind) {
  return models.some((m) => m.kind === kind || m.type === kind);
}