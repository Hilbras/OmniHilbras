// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-omnihilbras-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];

// Quota tracking for aggregator providers (one-api/new-api style hosts such as
// tokenharbor, nara-router, apmix, apinex, tiarina, xkiro). Candidate endpoint
// flavors are tried in order; per-provider pinning lives in each registry's
// usage.flavor. Env: AGGREGATOR_USAGE_* overrides.
export const AGGREGATOR_USAGE_CONFIG = {
  candidates: [
    // OpenAI-billing pair (one-api/new-api expose /v1/dashboard/billing/…);
    // usage values come back in USD cents.
    { flavor: "openai-billing", path: "/dashboard/billing/subscription" },
    { flavor: "openai-billing", path: "/dashboard/billing/usage" },
    // new-api user/self lane; quota fields are in quota units.
    { flavor: "new-api", path: "/api/user/self" },
  ],
  usageWindowDays: 30,
  unsupportedTtlMs: envMs("AGGREGATOR_UNSUPPORTED_TTL_MS", 10 * 60 * 1000),
  // new-api family: quota units per USD (QuotaPerUnit default).
  newApiQuotaPerUnit: 500000,
  fetchTimeoutMs: 10000,
};

// Supabase-hosted wallets (Token Harbor). The account session — not the model
// API key — is what can read the prepaid wallet, so this flavor needs the
// connection's Supabase user token. The anon key is the provider's own public
// key (it ships in its frontend bundle).
//
// This config lives here (not in the OAuth constants) because open-sse/config
// is imported by contexts where the "@/" alias does not resolve — the wallet
// reader must not drag the app's src tree in with it.
export const AGGREGATOR_WALLET_CONFIG = {
  supabaseUrl: process.env.AGGREGATOR_WALLET_SUPABASE_URL || "https://isbnzmwjmtiuipesgmmg.supabase.co",
  // Token Harbor's own public Supabase anon key (it ships in the
  // provider's frontend bundle) — not a secret, but config is its home.
  anonKey: process.env.AGGREGATOR_WALLET_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzYm56bXdqbXRpdWlwZXNnbW1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NjU1MzYsImV4cCI6MjA5MjM0MTUzNn0.CodUcchio6jNW_k68vaAb--LshBQXK51tZ6VTxNSz_A",
  authBaseUrl: process.env.AGGREGATOR_WALLET_AUTH_BASE_URL || "https://auth.tokenharbor.ai/auth/v1",
  walletTable: "wallets",
  walletColumns: ["balance_paid", "balance_trial", "balance_bonus", "balance_bonus_locked"],
  // Locked bonus credits are not spendable yet, so they stay out of the total.
  lockedColumn: "balance_bonus_locked",
};
