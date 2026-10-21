import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  WEB_COOKIE_SESSION_PROVIDERS,
} from "@/shared/constants/providers";

/**
 * The provider page resolves a provider id against one constant per category.
 *
 * A category the page does not know about means its providers have no page at
 * all: the page answers "Provider not found". That is how the web-session
 * group lost its pages when the category was added.
 *
 * So every category the registry uses has to be in the page's chain — this
 * test fails the moment a category is added without teaching the page about
 * it.
 */
const PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "providers",
  "[id]",
  "page.js",
);

const CATEGORIES = {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  WEB_COOKIE_SESSION_PROVIDERS,
};

describe("provider page resolution", () => {
  const source = readFileSync(PAGE, "utf8");

  // The chain that resolves a provider id to its entry — the else branch of
  // the providerNode ternary.
  const chain = source.match(/\(\s*OAUTH_PROVIDERS\[providerId\][^;]*?\)\s*;/)?.[0] || "";

  it("knows every category that holds providers", () => {
    expect(chain, "could not find the provider resolution chain in the page").not.toBe("");
    for (const [name, entries] of Object.entries(CATEGORIES)) {
      if (Object.keys(entries).length === 0) continue;
      expect(chain, `${name} is not in the provider page's resolution chain`).toContain(`${name}[providerId]`);
    }
  });

  it("resolves every provider in the registry to a page", () => {
    const known = new Set(
      Object.values(CATEGORIES).flatMap((entries) => Object.keys(entries)),
    );
    const missing = REGISTRY.map((e) => e.id).filter((id) => !known.has(id));
    expect(missing).toEqual([]);
  });

  it("gives every provider in the web-session group a page", () => {
    for (const id of Object.keys(WEB_COOKIE_SESSION_PROVIDERS)) {
      expect(source, `${id} cannot be resolved by the provider page`).toContain("WEB_COOKIE_SESSION_PROVIDERS[providerId]");
    }
  });
});
