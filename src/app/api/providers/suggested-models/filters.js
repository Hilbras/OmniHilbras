import { normalizeNousFreeModels } from "open-sse/services/nous.js";

// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Upstream returns "Model is unavailable" for this id (2026-09-02) — re-enable when fixed
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // Go subscription catalogue — every /models id is selectable; the endpoint lane
  // per model is resolved by the family regex (see open-sse/providers/models/helpers.js)
  "opencode-go": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // MiniMax Code (mcode) live catalog: {providers:[{providerId:"minimax",
  // config:{models:{<id>:{name, limit, modalities, thinking_config}}}}]} —
  // arrives wrapped in a single-element array (see route normalization).
  "minimax-code": (raw) => {
    const env = Array.isArray(raw) ? raw[0] : raw;
    const p = (Array.isArray(env?.providers) ? env.providers : []).find((x) => x?.providerId === "minimax");
    const ms = p?.config?.models;
    if (!ms || typeof ms !== "object") return [];
    return Object.entries(ms)
      .filter(([id, m]) => typeof id === "string" && id.trim() !== "" && m && typeof m === "object")
      .map(([id, m]) => ({ id, name: m?.name || id, contextLength: Number(m?.limit?.context) || undefined }))
      .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
  },

  "airforce-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => (m.tier === "free" || m.id?.endsWith(":free")) && m.supports_chat === true && (!m.media_type || m.media_type === "chat" || m.media_type === "text"))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),

  "nous-free": normalizeNousFreeModels,

  // ADCode desktop Included-AI live catalogue: /config returns
  // { available, defaultModel, models: [{ id, name, contextWindow, maxOutput, … }] }
  // — route unwraps json.models so this receives the models array directly.
  "adcode-config": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string" && m.id.trim() !== "")
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextLength: Number(m.contextWindow) || undefined,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),

  // Ollama Local /api/tags catalog: { models: [{ name, model, modified_at, size, ... }] }
  "ollama-local": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.model === "string" && m.model.trim() !== "")
      .map((m) => ({
        id: m.model,
        name: m.name || m.model,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),

  // Generic OpenAI-compatible /v1/models catalogues (free-tier aggregators).
  // Returns every model with the real context window the provider publishes —
  // context_length / context_window / max_context_tokens / max_tokens, in that order.
  // No free-only filter: these gateways mix free and paid ids behind one key.
  openai: (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string" && m.id.trim() !== "")
      .map((m) => {
        const ctx =
          Number(m.context_length) ||
          Number(m.context_window) ||
          Number(m.max_context_tokens) ||
          Number(m.max_context) ||
          Number(m.contextLength) ||
          undefined;
        return {
          id: m.id,
          name: m.name || m.display_name || m.id,
          contextLength: ctx && Number.isFinite(ctx) ? ctx : undefined,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
};
