/**
 * Token Harbor OAuth provider tests (src/lib/oauth/providers/tokenharbor.js).
 *
 * Token Harbor runs on Supabase: GoTrue issues the session, the wallet lives
 * in PostgREST. The provider builds the authorize URL (PKCE) and exchanges the
 * callback code; these tests cover the URL/state wiring and the token mapping.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { generatePKCE } from "@/lib/oauth/utils/pkce.js";
import tokenharbor, { parseReturnedCode } from "@/lib/oauth/providers/tokenharbor.js";

const setup = { fetchResponses: [], calls: [] };

vi.stubGlobal("fetch", async (url, opts = {}) => {
  setup.calls.push({ url, opts });
  const next = setup.fetchResponses.shift() ?? { status: 400, json: { msg: "no response queued" } };
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    text: async () => (typeof next.text === "string" ? next.text : JSON.stringify(next.json ?? {})),
  };
});

beforeEach(() => {
  setup.fetchResponses.length = 0;
  setup.calls.length = 0;
});

const REDIRECT = "http://localhost:20138/callback";

describe("tokenharbor oauth provider", () => {
  it("builds a PKCE authorize URL that lands on the provider's plain-text path", () => {
    const { codeVerifier, codeChallenge, state } = generatePKCE();
    const url = new URL(
      tokenharbor.buildAuthUrl(tokenharbor.config, REDIRECT, state, codeChallenge, { authMethod: "google" }),
    );

    expect(url.origin + url.pathname).toBe("https://auth.tokenharbor.ai/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");

    // GoTrue pins the redirect to the provider's own host, so the code lands
    // on a plain-text path there (their JS never runs) with our state on it.
    const redirectTo = new URL(url.searchParams.get("redirect_to"));
    expect(redirectTo.origin).toBe("https://tokenharbor.ai");
    expect(redirectTo.pathname).toBe("/robots.txt");
    expect(redirectTo.searchParams.get("th_state")).toBe(state);
  });

  it("parses a pasted landing URL back into code + state", () => {
    const parsed = parseReturnedCode(
      "https://tokenharbor.ai/robots.txt?code=abc-123&th_state=state-9",
    );
    expect(parsed).toEqual({ code: "abc-123", state: "state-9" });

    // A bare code works too (no state → the caller falls back to its own).
    expect(parseReturnedCode("abc-123")).toEqual({ code: "abc-123", state: null });
    expect(parseReturnedCode("")).toBeNull();
  });

  it("exchanges the callback code with the same redirect_to it was authorized with", async () => {
    setup.fetchResponses = [
      {
        status: 200,
        json: {
          access_token: "user-jwt",
          refresh_token: "refresh-1",
          expires_in: 3600,
          user: { id: "user-123", email: "captain@example.com" },
        },
      },
    ];
    const { codeVerifier, codeChallenge, state } = generatePKCE();
    const tokens = await tokenharbor.exchangeToken(
      tokenharbor.config,
      "the-code",
      REDIRECT,
      codeVerifier,
      state,
      { authMethod: "google" },
    );

    const call = setup.calls[0];
    expect(call.url).toContain("/auth/v1/token?grant_type=pkce");
    const body = JSON.parse(call.opts.body);
    expect(body.auth_code).toBe("the-code");
    expect(body.code_verifier).toBe(codeVerifier);
    // redirect_to must match the authorize request exactly — the landing pad
    // on the provider's host, with our state on it.
    const redirectTo = new URL(body.redirect_to);
    expect(redirectTo.origin).toBe("https://tokenharbor.ai");
    expect(redirectTo.pathname).toBe("/robots.txt");
    expect(redirectTo.searchParams.get("th_state")).toBe(state);
    expect(call.opts.headers.apikey).toBe(tokenharbor.config.anonKey);
  });

  it("maps the GoTrue response onto connection fields", () => {
    const mapped = tokenharbor.mapTokens({
      access_token: "user-jwt",
      refresh_token: "refresh-1",
      expires_in: 3600,
      user: { id: "user-123", email: "captain@example.com", user_metadata: { full_name: "Captain" } },
      _authMethod: "google",
    });

    expect(mapped.accessToken).toBe("user-jwt");
    expect(mapped.refreshToken).toBe("refresh-1");
    expect(mapped.expiresIn).toBe(3600);
    expect(mapped.email).toBe("captain@example.com");
    expect(mapped.displayName).toBe("Captain");
    expect(mapped.providerSpecificData.thUserId).toBe("user-123");
    expect(mapped.providerSpecificData.authMethod).toBe("google");
  });

  it("password login posts the GoTrue password grant", async () => {
    setup.fetchResponses = [
      { status: 200, json: { access_token: "user-jwt", refresh_token: "refresh-2", expires_in: 3600, user: { id: "u1", email: "a@b.c" } } },
    ];
    const tokens = await tokenharbor.passwordLogin(tokenharbor.config, "a@b.c", "secret");

    const call = setup.calls[0];
    expect(call.url).toContain("grant_type=password");
    expect(JSON.parse(call.opts.body)).toEqual({ email: "a@b.c", password: "secret" });
    expect(tokens.access_token).toBe("user-jwt");
  });

  it("surfaces GoTrue's message on bad credentials instead of throwing a raw error", async () => {
    setup.fetchResponses = [{ status: 400, json: { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" } }];
    await expect(tokenharbor.passwordLogin(tokenharbor.config, "a@b.c", "wrong")).rejects.toThrow(
      /Invalid login credentials/,
    );
  });

  it("refresh posts the refresh_token grant", async () => {
    setup.fetchResponses = [{ status: 200, json: { access_token: "new-jwt", refresh_token: "refresh-3" } }];
    const tokens = await tokenharbor.refresh(tokenharbor.config, "refresh-2");

    expect(setup.calls[0].url).toContain("grant_type=refresh_token");
    expect(JSON.parse(setup.calls[0].opts.body)).toEqual({ refresh_token: "refresh-2" });
    expect(tokens.access_token).toBe("new-jwt");
  });
});
