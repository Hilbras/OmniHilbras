// Provider icon paths under /public/providers.
// Alias related brands; session-cache 404s so one miss never spams again.

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "ollama-search": "ollama",
  // MiniMax Code rides the existing MiniMax brand mark
  "minimax-code": "minimax",
  "minimax-code-global": "minimax",
};

// Providers whose bundled mark is not `{id}.png` (svg / webp under their own filename).
const ICON_FILES = {
  "nara-router": "bynara-logo-icon-light.svg",
  tiarina: "Tirina.webp",
  xkiro: "xkiro-logo.svg",
};

// Runtime only — first 404 remembers id for the whole session
const failedIds = new Set();

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  return providerId.trim().toLowerCase();
}

/** Resolve icon file id (after alias). Empty if previously failed this session. */
export function resolveProviderIconId(providerId) {
  const id = normalizeId(providerId);
  if (!id) return "";
  if (failedIds.has(id)) return "";
  const aliased = ICON_ALIASES[id] || id;
  if (failedIds.has(aliased)) return "";
  return aliased;
}

/** Icon path under /providers — explicit file first, else `{id}.png`. Null when failed. */
export function getProviderIconSrc(providerId) {
  const id = normalizeId(providerId);
  if (!id || failedIds.has(id)) return null;
  const file = ICON_FILES[id];
  if (file) return `/providers/${file}`;
  const resolved = resolveProviderIconId(id);
  return resolved ? `/providers/${resolved}.png` : null;
}

/** Call from img onError so later mounts skip the request. */
export function markProviderIconMissing(providerId) {
  const id = normalizeId(providerId);
  if (id) failedIds.add(id);
  const aliased = ICON_ALIASES[id];
  if (aliased) failedIds.add(aliased);
}
