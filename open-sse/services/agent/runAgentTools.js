// Web-Cookie Agent tool execution — runs OmniHilbras's own built-in
// capabilities locally, as tools for the Web-Cookie Agent loop.
//
// Each tool re-enters the engine through the public API paths the gateway
// already serves (/api/v1/search, /api/v1/web/fetch, …) with the operator's
// own credentials, so:
//   - per-key access control and rate limiting still apply (the API layer
//     enforces them, exactly as for a normal external caller);
//   - the tools are whatever the operator has configured — a dedicated
//     search provider, a fetch pipeline, the image backend of their
//     choosing. Nothing is invented here; the tool layer only *selects*
//     the provider and shapes the answer.
//
// The chat model driving the loop gets plain-text results: long outputs are
// truncated, errors become explanatory text so the model can route around
// them instead of the whole turn dying.
//
// Loopback auth: the agent calls the gateway's own API on the loopback
// listener. The CLI token (machine-id derived, see src/lib/auth/cliToken.js)
// is what the dashboard's local routes accept for same-host callers — the
// same credential the dashboard itself uses, so no extra surface is added.

import { AGENT_TOOL_RESULT_MAX_CHARS, AGENT_TOOL_NAMES } from "./agentTools.js";

// The agent talks to the gateway's own loopback API. Default port matches
// UPDATER_CONFIG.appPort (custom-server.js binds it). Overridable so a
// test or a non-standard install can point it elsewhere.
const DEFAULT_AGENT_API_BASE = "http://127.0.0.1:20127";

function agentApiBaseUrl() {
  const explicit = process.env.OMNIHILBRAS_AGENT_API_BASE?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return DEFAULT_AGENT_API_BASE;
}

// The CLI token is the machine's own credential; read it lazily (rather than
// at import) so this module stays importable in tests without the local DB.
async function agentApiToken() {
  try {
    const { getCliToken } = await import("../../../../src/lib/auth/cliToken.js");
    return await getCliToken();
  } catch {
    return process.env.OMNIHILBRAS_AGENT_API_KEY?.trim() || "dummy";
  }
}

async function callAgentApi(path, body, token) {
  const res = await fetch(`${agentApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // CLI token rides the x-api-key header the auth layer extracts.
      "x-api-key": token,
    },
    body: JSON.stringify(body ?? {}),
    // The agent inherits the turn's abort where the caller passes a signal —
    // otherwise a 60s ceiling so a hung tool cannot hold the whole loop.
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`${path} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  // SSE endpoints stream text; JSON endpoints parse. A blank body is a valid
  // empty result, reported as "{}" rather than undefined.
  const trimmed = text.trim();
  if (!trimmed) return "{}";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

// ── Result shaping: anything → text the model can read ───────────────────────

function shapeResults(text, name) {
  // Search: keep the top results compact, title + url + snippet.
  if (name === "web_search") {
    try {
      const parsed = typeof text === "string" ? JSON.parse(text) : text;
      const results = parsed?.results;
      if (Array.isArray(results) && results.length) {
        return results
          .slice(0, 8)
          .map((r, i) => {
            const title = r.title || r.name || "";
            const url = r.url || r.link || "";
            const snippet = (r.snippet || r.content || r.description || "").slice(0, 300);
            return `${i + 1}. ${title} — ${url}${snippet ? `\n   ${snippet}` : ""}`;
          })
          .join("\n");
      }
    } catch {
      // fall through to the generic cap below
    }
  }

  const flat = typeof text === "string" ? text : JSON.stringify(text);
  if (flat.length <= AGENT_TOOL_RESULT_MAX_CHARS) return flat;
  return `${flat.slice(0, AGENT_TOOL_RESULT_MAX_CHARS)}\n…[truncated]`;
}

function toolError(message) {
  // An error is data for the model, not fatal to the turn: it says what
  // happened and leaves the model free to try another tool or answer anyway.
  return `[tool error] ${String(message || "unknown error").slice(0, 500)}`;
}

// ── The registry: tool name → executor ───────────────────────────────────────
// The built-in media providers (image/tts/stt/embedding/video) are selected
// by name from the settings when the operator named one; otherwise the API
// layer picks its default for each capability.
const TOOL_EXECUTORS = {
  web_search: async ({ query, provider }, token) => {
    if (!query) throw new Error("web_search needs a query");
    const json = await callAgentApi("/api/v1/search", {
      ...(provider ? { provider } : {}),
      query,
      max_results: 8,
    }, token);
    return shapeResults(json, "web_search");
  },

  web_fetch: async ({ url, query, provider }, token) => {
    // A query with no url means "search then read the top hit".
    const json = await callAgentApi("/api/v1/web/fetch", {
      ...(provider ? { provider } : {}),
      ...(url ? { url } : { query }),
    }, token);
    const content = json?.content ?? json?.text ?? json;
    return shapeResults(typeof content === "string" ? content : json, "web_fetch");
  },

  image_gen: async ({ prompt, width, height, provider }, token) => {
    if (!prompt) throw new Error("image_gen needs a prompt");
    const json = await callAgentApi("/api/v1/images/generations", {
      ...(provider ? { provider } : {}),
      prompt,
      ...(width ? { width: Number(width) } : {}),
      ...(height ? { height: Number(height) } : {}),
    }, token);
    const url = json?.data?.[0]?.url || json?.url || json?.data?.[0]?.b64_json || json;
    return shapeResults(typeof url === "string" ? url : json, "image_gen");
  },

  tts: async ({ text, voice, provider }, token) => {
    if (!text) throw new Error("tts needs text to speak");
    const json = await callAgentApi("/api/v1/audio/speech", {
      ...(provider ? { provider } : {}),
      text,
      ...(voice ? { voice } : {}),
    }, token);
    return shapeResults(json, "tts");
  },

  stt: async ({ audio, language, provider }, token) => {
    if (!audio) throw new Error("stt needs audio (URL or data-uri)");
    const json = await callAgentApi("/api/v1/audio/transcriptions", {
      ...(provider ? { provider } : {}),
      audio,
      ...(language ? { language } : {}),
    }, token);
    const transcript = json?.text || json?.transcript || json;
    return shapeResults(typeof transcript === "string" ? transcript : json, "stt");
  },

  embeddings: async ({ input, provider }, token) => {
    if (!input) throw new Error("embeddings needs input text");
    const json = await callAgentApi("/api/v1/embeddings", {
      ...(provider ? { provider } : {}),
      input,
    }, token);
    const vec = json?.data?.[0]?.embedding || json;
    // Vectors are large; the model only needs to know the dimensionality.
    const dims = Array.isArray(vec) ? vec.length : "?";
    return shapeResults(`[vector: ${dims} dims] ${JSON.stringify(Array.isArray(vec) ? vec.slice(0, 12) : vec)}`, "embeddings");
  },

  video_gen: async ({ prompt, provider }, token) => {
    if (!prompt) throw new Error("video_gen needs a prompt");
    const json = await callAgentApi("/api/v1/videos/generations", {
      ...(provider ? { provider } : {}),
      prompt,
    }, token);
    const url = json?.data?.[0]?.url || json?.url || json;
    return shapeResults(typeof url === "string" ? url : json, "video_gen");
  },
};

/**
 * Execute one agent tool call.
 *
 * @param {string} name  tool name (one of AGENT_TOOL_NAMES)
 * @param {object} args   parsed arguments (from the model's function.arguments)
 * @param {object} [ctx]  { log } — logging only; tools are isolated to their
 *   target services, no other side effects.
 * @returns {Promise<{ ok: boolean, result: string, error?: string }>}
 */
export async function executeAgentTool(name, args, ctx = {}) {
  const executor = TOOL_EXECUTORS[name];
  if (!executor) {
    return { ok: false, result: toolError(`unknown tool "${name}"`) };
  }
  const log = ctx.log;
  try {
    const token = await agentApiToken();
    log?.info?.("AGENT-TOOLS", `→ ${name} ${JSON.stringify(args || {}).slice(0, 120)}`);
    const result = await executor(args || {}, token);
    return { ok: true, result };
  } catch (error) {
    log?.warn?.("AGENT-TOOLS", `${name} failed: ${error?.message || error}`);
    return { ok: false, result: toolError(error?.message || error), error: error?.message || String(error) };
  }
}

// Which tools are actually usable depends on what the operator wired up.
// The full catalogue is advertised regardless — an unconfigured tool answers
// with an explanatory error instead of a silent 5xx, which is kinder to a
// model that picked it.
export { TOOL_EXECUTORS, AGENT_TOOL_NAMES };
