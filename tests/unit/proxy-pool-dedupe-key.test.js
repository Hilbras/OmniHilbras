import { describe, expect, it } from "vitest";
import {
  normalizeProxyUrl,
  proxyPoolDedupeKey,
} from "@/app/(dashboard)/dashboard/proxy-pools/proxyPoolKeys.js";

describe("proxy pool dedupe key", () => {
  it("normalises a bare host the same way the import does", () => {
    expect(normalizeProxyUrl("http://1.2.3.4:8080")).toBe("http://1.2.3.4:8080/");
  });

  it("keeps a URL the parser cannot read", () => {
    expect(normalizeProxyUrl("not a url")).toBe("not a url");
  });

  it("treats a hand-typed pool and an imported pool as the same pool", () => {
    const stored = proxyPoolDedupeKey("http://1.2.3.4:8080");
    const imported = proxyPoolDedupeKey("http://1.2.3.4:8080/");
    expect(stored).toBe(imported);
  });

  it("keeps pools with different no-proxy lists apart", () => {
    expect(proxyPoolDedupeKey("http://1.2.3.4:8080", "localhost"))
      .not.toBe(proxyPoolDedupeKey("http://1.2.3.4:8080"));
  });

  it("keeps different proxies apart", () => {
    expect(proxyPoolDedupeKey("http://1.2.3.4:8080"))
      .not.toBe(proxyPoolDedupeKey("http://1.2.3.4:9090"));
  });
});
