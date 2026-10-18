/**
 * Tests for #4399 — CLI Tools Apply writes placeholder "sk_omnihilbras" key.
 *
 * When requireApiKey=true, the written "sk_omnihilbras" caused 401 on every
 * CLI tool request. The fix: replace the literal fallback with
 * resolveCliApiKey(), which reads the first active key from the DB
 * (or returns "" if none exist — never the placeholder).
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Test the resolveCliApiKey logic in isolation.
// The actual module reads from SQLite; we replicate the decision logic here.

function resolveCliApiKeyLogic(callerKey, activeKeys = []) {
  if (callerKey && callerKey.trim() && callerKey.trim() !== "sk_omnihilbras") {
    return callerKey.trim();
  }
  const active = activeKeys.find((k) => k.isActive);
  return active?.key || "";
}

describe("resolveCliApiKey logic (#4399)", () => {
  it("returns the caller key when non-empty and not the placeholder", () => {
    expect(resolveCliApiKeyLogic("sk-real-key-123", [])).toBe("sk-real-key-123");
  });

  it("falls back to first active DB key when caller key is empty", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic("", keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller key is null", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic(null, keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller key is undefined", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic(undefined, keys)).toBe("sk-db-key");
  });

  it("falls back to first active DB key when caller is the placeholder itself", () => {
    const keys = [{ key: "sk-db-key", isActive: true }];
    expect(resolveCliApiKeyLogic("sk_omnihilbras", keys)).toBe("sk-db-key");
  });

  it("skips inactive keys and picks the first active one", () => {
    const keys = [
      { key: "sk-inactive", isActive: false },
      { key: "sk-active", isActive: true },
    ];
    expect(resolveCliApiKeyLogic("", keys)).toBe("sk-active");
  });

  it("returns empty string when no active DB key exists and caller is empty", () => {
    const keys = [{ key: "sk-inactive", isActive: false }];
    expect(resolveCliApiKeyLogic("", keys)).toBe("");
  });

  it("returns empty string when DB is empty and caller is empty", () => {
    expect(resolveCliApiKeyLogic("", [])).toBe("");
  });

  it("trims whitespace from caller key", () => {
    expect(resolveCliApiKeyLogic("  sk-real  ", [])).toBe("sk-real");
  });

  it("never returns sk_omnihilbras", () => {
    expect(resolveCliApiKeyLogic("sk_omnihilbras", [])).not.toBe("sk_omnihilbras");
    expect(resolveCliApiKeyLogic("", [])).not.toBe("sk_omnihilbras");
  });
});

describe("resolveApiKey.js source checks (#4399)", () => {
  const src = fs.readFileSync(
    new URL("../../src/app/api/cli-tools/resolveApiKey.js", import.meta.url),
    "utf-8"
  );

  it("resolveApiKey.js exports resolveCliApiKey", () => {
    expect(src).toContain("resolveCliApiKey");
  });

  it("resolveApiKey.js imports getApiKeys from DB", () => {
    expect(src).toContain("getApiKeys");
  });

  it("resolveApiKey.js does not return sk_omnihilbras as a fallback value", () => {
    // The helper may reference "sk_omnihilbras" to guard against it, but must
    // never use it as a return / fallback value (e.g. `return "sk_omnihilbras"`).
    expect(src).not.toMatch(/return\s+"sk_omnihilbras"/);
    expect(src).not.toMatch(/\|\|\s*"sk_omnihilbras"/);
  });
});