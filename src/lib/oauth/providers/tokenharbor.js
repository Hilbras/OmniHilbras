import { TOKENHARBOR_CONFIG } from "../constants/tokenharbor.js";

// Token Harbor account login.
//
// Token Harbor runs on Supabase: GoTrue handles the session, PostgREST serves
// the prepaid wallet. Two sign-in paths are supported:
//
//   google   — PKCE authorization code through the provider's own auth page
//              (the user signs in with Google/GitHub/email on their site).
//   password — direct GoTrue password grant (email + password).
//
// Both yield a Supabase user JWT (`access_token`) that the wallet reader uses;
// the refresh token keeps the session alive across restarts.
//
// The model API key is NOT involved here: it lives on the connection's
// `apiKey` field and is what routes traffic. This session only reads quota.

async function gotrueJson(url, { method = "GET", body, anonKey }) {
  const response = await fetch(url, {
    method,
    headers: {
      apikey: anonKey,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.msg || data?.message || data?.error_description || text || response.status;
    throw new Error(`Token Harbor auth failed: ${message}`);
  }
  return data;
}

// Append our CSRF state to the redirect URL. GoTrue echoes `redirect_to`
// back on the callback, so the state survives the provider round-trip.
function appendState(redirectUri, state) {
  if (!state) return redirectUri;
  try {
    const url = new URL(redirectUri);
    url.searchParams.set("th_state", state);
    return url.toString();
  } catch {
    return redirectUri;
  }
}

// Where the authorization code lands.
//
// GoTrue only accepts redirect targets on Token Harbor's own host — any other
// host is silently rewritten to `https://tokenharbor.ai`, which is why the
// code used to end up on their landing page and fail to exchange (their JS
// holds a different PKCE verifier than ours).
//
// So the flow lands on a path on their host that serves plain text: the
// browser shows it verbatim instead of running their app, so the `code` stays
// readable in the address bar and the user can hand it back to us. Our state
// rides along as `th_state` so the exchange stays bound to this attempt.
const LANDING_PATH = "/robots.txt";


// The URL GoTrue will actually redirect to: the provider's own host, on a
// path that serves plain text (so their JS never runs and the code stays in
// the address bar).
function landingUrl(config, redirectUri) {
  try {
    const base = new URL(redirectUri);
    const host = config.landingHost || base.origin;
    const path = config.landingPath || LANDING_PATH;
    return new URL(path, host).toString();
  } catch {
    return redirectUri;
  }
}

// Extract the authorization code from a URL the user pasted back — the
// landing page URL, or just the bare code.
export function parseReturnedCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const code = url.searchParams.get("code");
    if (code) {
      return { code, state: url.searchParams.get("th_state") || null };
    }
  } catch {
    // Not a URL — maybe the bare code.
  }
  return { code: raw, state: null };
}

const tokenharbor = {
  config: TOKENHARBOR_CONFIG,
  flowType: "authorization_code_pkce",

  // The landing pad is on the provider's host, not ours.
  prepareConfig: async (config, meta = {}) => ({
    ...config,
    redirectUri: meta.redirectUri || config.redirectUri,
    authMethod: meta.authMethod || "google",
  }),

  buildAuthUrl: (config, redirectUri, state, codeChallenge, meta = {}) => {
    const params = new URLSearchParams({
      provider: meta.authMethod === "password" ? "google" : (meta.authMethod || "google"),
      // GoTrue replaces any `state` we send with its own UUID, so our state
      // rides inside `redirect_to` — it survives the provider round-trip and
      // comes back on the callback, which binds the exchange to this attempt.
      redirect_to: appendState(landingUrl(config, redirectUri), state),
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", config.codeChallengeMethod);
    }
    return `${config.authBaseUrl}${config.authorizeUrlPath}?${params.toString()}`;
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta = {}) => {
    // GoTrue checks that `redirect_to` matches the one it saw at /authorize —
    // which was the landing pad on the provider's host, state included.
    const tokens = await gotrueJson(
      `${config.authBaseUrl}${config.tokenUrlPath}?grant_type=pkce`,
      {
        method: "POST",
        anonKey: config.anonKey,
        body: {
          auth_code: code,
          code_verifier: codeVerifier,
          redirect_to: appendState(landingUrl(config, redirectUri), state),
        },
      },
    );
    return { ...tokens, _authMethod: meta.authMethod || "google" };
  },

  // Password grant — used by the "email + password" option on the modal.
  // Never logged, never persisted.
  passwordLogin: async (config, email, password) => {
    const tokens = await gotrueJson(
      `${config.authBaseUrl}${config.tokenUrlPath}?grant_type=password`,
      {
        method: "POST",
        anonKey: config.anonKey,
        body: { email, password },
      },
    );
    return { ...tokens, _authMethod: "password" };
  },

  // Refresh an expired session; GoTrue rotates the refresh token.
  refresh: async (config, refreshToken) => {
    const tokens = await gotrueJson(
      `${config.authBaseUrl}${config.tokenUrlPath}?grant_type=refresh_token`,
      {
        method: "POST",
        anonKey: config.anonKey,
        body: { refresh_token: refreshToken },
      },
    );
    return tokens;
  },

  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    email: tokens.user?.email || null,
    displayName: tokens.user?.user_metadata?.full_name || tokens.user?.email || "Token Harbor",
    providerSpecificData: {
      authMethod: tokens._authMethod || "google",
      thUserId: tokens.user?.id || null,
      thEmail: tokens.user?.email || null,
      thAuthBaseUrl: TOKENHARBOR_CONFIG.authBaseUrl,
    },
  }),
};

export default tokenharbor;
