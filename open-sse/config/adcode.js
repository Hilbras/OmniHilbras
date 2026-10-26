// ADCode "Included AI" (tagflow) — the ADCode desktop client's AI backend
// (reverse-engineered from the desktop bundle, verified live 2026-10):
//
//   - The desktop app signs in to a Firebase/identity backend and keeps
//     { uid, refreshToken } in a per-user store file
//     (~/.config/@adcode/desktop/ads/ads/identity.json on Linux).
//   - A live id_token is minted from the refresh token via the Firebase
//     secure-token endpoint and presented to the tagflow relay as
//     Authorization: Bearer.
//   - The relay is OpenAI-compatible: /chat/completions streams native
//     OpenAI SSE and native tool_calls (no bridge needed, unlike zcode).
//   - /config is public (the desktop app's live model catalogue);
//     /usage is auth-gated and reports the account's credit pools.
//
// Environment overrides (for testing / non-default installs):
//   ADCODE_ORIGIN            — relay origin (default adcode.bluethenics.com)
//   ADCODE_FIREBASE_API_KEY  — Firebase web API key used to mint tokens
//   ADCODE_IDENTITY_FILE     — path to the desktop identity store
//   ADCODE_ACCESS_TOKEN / ADCODE_TOKEN — a pasted/externally-minted id_token

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// The desktop app reads ADCODE_AD_SERVER the same way (verified in its source);
// an env-only override works even where the store lives elsewhere.
const ORIGIN = process.env.ADCODE_ORIGIN?.trim() || "https://adcode.bluethenics.com";
const API_BASE = `${ORIGIN}/v1`;
const TAGFLOW_BASE = `${API_BASE}/ai/tagflow`;

export const ADCODE_CHAT_URL = `${TAGFLOW_BASE}/chat/completions`;
export const ADCODE_CONFIG_URL = `${TAGFLOW_BASE}/config`;
export const ADCODE_USAGE_URL = `${TAGFLOW_BASE}/usage`;

// Firebase secure-token endpoint the desktop client mints id_tokens from.
export const ADCODE_FIREBASE_REFRESH_URL = "https://securetoken.googleapis.com/v1/token";
export const ADCODE_FIREBASE_API_KEY =
  process.env.ADCODE_FIREBASE_API_KEY?.trim() || "AIzaSyATZzX5Fw2HjR34VxB3UQWTmljprA5uXqE";
// Refresh skew, same value the desktop client uses — don't hold the last
// minute of a token's life: that trips upstream 401s.
export const ADCODE_REFRESH_SKEW_MS = 6e4;

// Minted-token cache, per-process. The desktop client caches identically
// (id_token + expiresAt), and the refresh endpoint rotates refresh_token,
// so a rotated token must be written back to the store or the next run
// (and the desktop client itself) loses its session.
const minted = { token: null, expiresAt: 0 };

// The desktop app writes identity.json into <userData>/ads; on Linux that
// is ~/.config/@adcode/desktop — the nested "ads/ads" segment is its own
// doing (store key "ads/identity.json" under the ads dir).
function resolveIdentityPath() {
  const override = process.env.ADCODE_IDENTITY_FILE?.trim();
  if (override) return override;
  const p = platform();
  const name = p === "win32" ? "AppData" : p === "darwin" ? "Library/Application Support" : ".config";
  const base = p === "win32" ? process.env.APPDATA : p === "darwin" ? join(homedir(), name) : join(homedir(), ".config");
  return join(base, "@adcode", "desktop", "ads", "ads", "identity.json");
}

export function readAdcodeIdentityStore(path = resolveIdentityPath()) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const uid = typeof parsed?.uid === "string" ? parsed.uid : "";
    const refreshToken = typeof parsed?.refreshToken === "string" ? parsed.refreshToken : "";
    if (!uid || !refreshToken) return null;
    return { uid, refreshToken };
  } catch {
    return null;
  }
}

export function writeAdcodeIdentityStore(identity, path = resolveIdentityPath()) {
  if (!identity?.refreshToken) return;
  const target = path || resolveIdentityPath();
  try {
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, JSON.stringify(identity));
  } catch {
    // Best-effort: the desktop client re-mints fine even if the rotation
    // can't be persisted here (read-only FS etc.).
  }
}

/**
 * Resolve an ADCode id_token for the relay.
 *
 * Order: pasted connection key → ADCODE_ACCESS_TOKEN / ADCODE_TOKEN env →
 * the desktop identity store (refresh-token exchange, cached with skew,
 * rotated refresh_token written back).
 *
 * @returns {{ token: string, source: "connection" | "env" | "desktop" }}
 * @throws when no source yields a token (message carries "not signed in"
 * so callers can produce the friendly dashboard error).
 */
export async function resolveAdcodeToken(credentials, { signal, proxyOptions } = {}) {
  const pasted = String(credentials?.apiKey || credentials?.accessToken || "").trim();
  if (pasted) return { token: pasted, source: "connection" };

  const envToken = (process.env.ADCODE_ACCESS_TOKEN || process.env.ADCODE_TOKEN || "").trim();
  if (envToken) return { token: envToken, source: "env" };

  if (minted.token && Date.now() < minted.expiresAt - ADCODE_REFRESH_SKEW_MS) {
    return { token: minted.token, source: "desktop" };
  }

  const store = readAdcodeIdentityStore();
  if (!store) {
    throw new Error(
      "ADCode desktop client is not signed in on this machine: no identity store found. " +
      "Install ADCode and sign in once, or set ADCODE_ACCESS_TOKEN / paste an id_token as the key."
    );
  }

  const url = `${ADCODE_FIREBASE_REFRESH_URL}?key=${encodeURIComponent(ADCODE_FIREBASE_API_KEY)}`;
  const form = `grant_type=refresh_token&refresh_token=${encodeURIComponent(store.refreshToken)}`;
  const response = await proxyAwareFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal,
  }, proxyOptions);

  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* fall through */ }
  if (!response.ok || !body?.id_token) {
    const detail = body?.error?.message || text.slice(0, 160) || `HTTP ${response.status}`;
    throw new Error(`ADCode token refresh failed: ${detail}`);
  }

  const expiresMs = Number(body.expires_in) * 1000;
  minted.token = body.id_token;
  minted.expiresAt = Date.now() + (Number.isFinite(expiresMs) && expiresMs > 0 ? expiresMs : 3600e3);
  // Persist the rotated refresh token (uid preserved so the store keeps the
  // identity it had) — the desktop app expects its own store to stay valid.
  writeAdcodeIdentityStore({ uid: store.uid, refreshToken: body.refresh_token || store.refreshToken });

  return { token: body.id_token, source: "desktop" };
}

export function clearAdcodeTokenCache() {
  minted.token = null;
  minted.expiresAt = 0;
}
