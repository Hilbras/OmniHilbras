// Token Harbor — account (wallet) auth configuration.
//
// Token Harbor is a Supabase app: the session comes from GoTrue on
// `auth.tokenharbor.ai` and the prepaid wallet lives in the PostgREST table
// `wallets` on the project's Supabase host.
//
// The wallet endpoints live in open-sse/config/runtimeConfig.js
// (AGGREGATOR_WALLET_CONFIG) because that module is loaded by contexts where
// the "@/" alias does not resolve — this file reads from it instead of
// duplicating the values.
import { AGGREGATOR_WALLET_CONFIG } from "open-sse/config/runtimeConfig.js";

// The Supabase anon key is the provider's own public key — it ships inside
// Token Harbor's frontend bundle, so it is not a secret, but it is still a
// credential-looking string and belongs in config rather than inline.
const ANON_KEY =
  process.env.AGGREGATOR_WALLET_ANON_KEY || AGGREGATOR_WALLET_CONFIG.anonKey;

export const TOKENHARBOR_CONFIG = {
  // GoTrue (Supabase Auth) endpoints
  authBaseUrl: AGGREGATOR_WALLET_CONFIG.authBaseUrl,
  authorizeUrlPath: "/authorize",
  tokenUrlPath: "/token",

  // Supabase data API (PostgREST) — wallet reads
  supabaseUrl: AGGREGATOR_WALLET_CONFIG.supabaseUrl,
  anonKey: ANON_KEY,

  // GoTrue only accepts redirect targets on the provider's own host, so the
  // authorization code lands here. The path serves plain text, so the
  // provider's JavaScript never runs and the code stays readable.
  landingHost: "https://tokenharbor.ai",
  landingPath: "/robots.txt",

  // Wallet table + columns (the only table the Token Harbor frontend reads)
  walletTable: AGGREGATOR_WALLET_CONFIG.walletTable,
  walletColumns: AGGREGATOR_WALLET_CONFIG.walletColumns,

  // Sign-in providers offered on the connection modal
  authMethods: ["google", "password"],

  // GoTrue PKCE
  codeChallengeMethod: "s256",

  // Supabase session lifetime is short; refresh before it lapses.
  refreshSkewMs: 60 * 1000,
};
