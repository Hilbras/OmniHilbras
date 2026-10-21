import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { WEB_COOKIE_SESSION_PROVIDERS } from "@/shared/constants/providers";
import { WEB_SESSION_PROVIDERS } from "@/shared/constants/webSessionProviders";

/**
 * The "Web Cookie Sessions" group.
 *
 * Six providers reached with a credential a signed-in browser holds. Each one
 * needs four things wired or it is invisible or broken: a registry entry, an
 * executor, a dashboard descriptor, and the session module the connect route
 * calls.
 */
const SIX = [
  "chatgpt-web",
  "deepseek-web",
  "duckduckgo-web",
  "gemini-web",
  "qwen-web",
  "tokenharbor-web",
];

describe("web cookie sessions group", () => {
  it("registers all six in the webCookieSession category", () => {
    const ids = REGISTRY.filter((e) => e.category === "webCookieSession").map((e) => e.id);
    for (const id of SIX) {
      expect(ids, `${id} is not in the webCookieSession category`).toContain(id);
    }
    expect(Object.keys(WEB_COOKIE_SESSION_PROVIDERS)).toHaveLength(SIX.length);
  });

  it("gives every one of them an executor", () => {
    for (const id of SIX) {
      const executor = getExecutor(id);
      expect(executor, `${id} has no executor`).toBeTruthy();
      expect(executor.getProvider()).toBe(id);
    }
  });

  it("publishes them through the provider barrel", () => {
    for (const id of SIX) {
      expect(PROVIDERS[id], `${id} is missing from PROVIDERS`).toBeTruthy();
      expect(PROVIDERS[id].baseUrl, `${id} has no baseUrl`).toBeTruthy();
      expect(PROVIDERS[id].authType, `${id} is not a cookie provider`).toBe("cookie");
    }
  });

  it("seeds a model list for each of them", () => {
    for (const id of SIX) {
      const models = PROVIDER_MODELS[id] || [];
      expect(models.length, `${id} has no models`).toBeGreaterThan(0);
    }
  });

  it("describes each of them for the dashboard dialog", () => {
    for (const id of SIX) {
      const descriptor = WEB_SESSION_PROVIDERS[id];
      expect(descriptor, `${id} has no dashboard descriptor`).toBeTruthy();
      expect(descriptor.name).toBeTruthy();
      expect(descriptor.website).toBeTruthy();
      expect(descriptor.extractionSteps.length, `${id} has no extraction steps`).toBeGreaterThan(0);
      expect(descriptor.paste?.field, `${id} has no paste field`).toBeTruthy();
    }
  });

  it("keeps the credential out of the request headers of the browser providers", () => {
    // ChatGPT Web and Gemini Web drive a real browser: the credential goes
    // into the cookie jar, because the page — not this process — makes the
    // request that carries it. A header would only reach the request log.
    //
    // The HTTP providers (qwen, deepseek, tokenharbor, duckduckgo) do send
    // it as a `Cookie` header — that is how the upstream receives it, and it
    // matches the shipped perplexity-web pattern. Request headers are never
    // written to the request log: only an allowlist of *response* headers is
    // (see open-sse/utils/upstreamHeaders.js).
    for (const id of ["chatgpt-web", "gemini-web"]) {
      const executor = getExecutor(id);
      const headers = executor.buildHeaders({ apiKey: "secret-cookie-value" }, false);
      const serialized = JSON.stringify(headers);
      expect(serialized, `${id} leaks the credential into its headers`).not.toContain("secret-cookie-value");
    }
  });

  it("ships the session module the connect route calls", async () => {
    // The dashboard's Check/Save buttons go through
    // /api/providers/web-session/[id], which imports
    // open-sse/shared/webSession/<id>.js. A missing module means the button
    // answers "not available in this build".
    for (const id of SIX) {
      const mod = await import(`../../open-sse/shared/webSession/${id}.js`);
      expect(typeof mod.checkWebSession, `${id} has no checkWebSession`).toBe("function");
      expect(typeof mod.connectWebSession, `${id} has no connectWebSession`).toBe("function");
    }
  });
});
