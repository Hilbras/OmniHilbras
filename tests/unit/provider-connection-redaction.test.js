import { describe, expect, it } from "vitest";

import { toProviderConnectionResponse } from "@/lib/providerConnectionResponse";

/**
 * The provider connection response.
 *
 * `providerSpecificData` holds live credentials for several providers —
 * GitHub's `copilotToken`, Kiro's IDC `clientSecret`, Xiaomi's
 * `mimoPassToken`, the AWS `sessionToken`. The response helper used to strip
 * only the four top-level fields and passed the rest of that object through
 * verbatim, so any dashboard client (and, where `requireLogin` is off, any
 * caller) received every provider's live credentials.
 *
 * The rule now is an allow-list: only the fields a client legitimately needs
 * are returned.
 */
describe("toProviderConnectionResponse", () => {
  const connection = {
    id: "conn-1",
    provider: "github",
    name: "Account 1",
    apiKey: "sk-provider-key",
    accessToken: "provider-access-token",
    refreshToken: "provider-refresh-token",
    idToken: "provider-id-token",
    providerSpecificData: {
      // Safe — configuration and identity.
      baseUrl: "https://api.githubcopilot.com",
      region: "us-east-1",
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
      githubLogin: "octocat",
      chatgptAccountId: "acct-1",
      accessKeyId: "AKIAEXAMPLE",
      profile: "default",
      // Secrets — these must never leave the server.
      copilotToken: "gho_copilot_live_secret",
      clientSecret: "kiro-idc-client-secret",
      mimoPassToken: "mimo-session-secret",
      sessionToken: "aws-session-secret",
      apiKey: "nested-api-key-secret",
      refreshToken: "nested-refresh-secret",
    },
  };

  it("never returns a credential, at any depth", () => {
    const response = toProviderConnectionResponse(connection);
    const serialized = JSON.stringify(response);

    for (const secret of [
      "sk-provider-key",
      "provider-access-token",
      "provider-refresh-token",
      "provider-id-token",
      "gho_copilot_live_secret",
      "kiro-idc-client-secret",
      "mimo-session-secret",
      "aws-session-secret",
      "nested-api-key-secret",
      "nested-refresh-secret",
    ]) {
      expect(serialized, `${secret} leaked into the provider response`).not.toContain(secret);
    }
  });

  it("keeps the fields a dashboard client needs", () => {
    const response = toProviderConnectionResponse(connection);

    expect(response.id).toBe("conn-1");
    expect(response.provider).toBe("github");
    expect(response.name).toBe("Account 1");
    expect(response.providerSpecificData).toMatchObject({
      baseUrl: "https://api.githubcopilot.com",
      region: "us-east-1",
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
      githubLogin: "octocat",
      chatgptAccountId: "acct-1",
      accessKeyId: "AKIAEXAMPLE",
      profile: "default",
    });
  });

  it("drops a credential-looking field it was never told about", () => {
    // The allow-list is what protects the next provider that stores a
    // credential here — a deny-list would have leaked it by default.
    const response = toProviderConnectionResponse({
      provider: "future-provider",
      providerSpecificData: { baseUrl: "https://x", somethingNewSecret: "leak-me" },
    });
    expect(JSON.stringify(response)).not.toContain("leak-me");
    expect(response.providerSpecificData.baseUrl).toBe("https://x");
  });

  it("leaves a connection without providerSpecificData alone", () => {
    const response = toProviderConnectionResponse({ id: "c", provider: "x", apiKey: "sk-secret" });
    expect(response.providerSpecificData).toBeUndefined();
    expect(response.apiKey).toBeUndefined();
  });
});
