// Web-Cookie Agent — a server-side tool-execution loop layered over the
// "Web Cookie Sessions" / "Web Cookie Providers" groups (chatgpt-web, deepseek-web,
// duckduckgo-web, gemini-web, qwen-web, tokenharbor-web, grok-web, perplexity-web).
//
// These providers all answer in OpenAI chat-completions shape but almost none
// of them carry a native tool channel — they take a flat prompt and text out.
// An agent needs the opposite: the model asks to *call* a tool, OmniHilbras
// runs it, and the result comes back. This module closes that gap without
// touching any provider:
//
//   1. The model is offered OmniHilbras's own built-in capabilities as tools
//      (web_search, web_fetch, image_gen, tts, stt, embeddings, video) — see
//      runAgentTools.js for the tool registry and their local execution.
//   2. One turn of chat is requested from the active web-cookie model, with
//      that tool catalogue attached.
//   3. Whatever tool calls the model produces are executed locally, their
//      results appended as role:"tool" messages, and the model is asked to
//      continue — until it answers in prose or the loop cap is reached.
//
// The chat turn itself is driven through the normal executor pipeline (the
// web-cookie executors are OpenAI-shaped upstreams), so client-format
// translation, RTK compression and error handling all apply unchanged. The
// loop only decides *when to stop*: a prose answer, or the cap, or a
// provider that refuses tools (Duck.ai / Gemini-Web refuse tool_choice:"required").
//
// Fail-open throughout: a tool that errors is reported back to the model as a
// tool result with the error text, so the agent can route around it instead
// of the whole request dying.

import { WEB_COOKIE_PROVIDERS, WEB_COOKIE_SESSION_PROVIDERS } from "../../../src/shared/constants/providers.js";

// ── Group membership ─────────────────────────────────────────────────────────

// The full "web AI" pool the agent can route through: both the legacy
// Web-Cookie-Providers group (single session cookie for a service that also
// has an API) and the Web-Cookie-Sessions group (a whole browser session,
// no first-class API). Model strings are "provider/model" — the group is
// therefore a set of *provider ids*, and any of their models is reachable.
export const WEB_COOKIE_AGENT_PROVIDERS = [
  ...Object.keys(WEB_COOKIE_PROVIDERS || {}),
  ...Object.keys(WEB_COOKIE_SESSION_PROVIDERS || {}),
];

// ── Loop caps (config-level: no hardcoding of behaviour elsewhere) ──────────
export const AGENT_MAX_TOOL_ROUNDS = 6;     // model → tool → model … stops here
export const AGENT_MAX_TOOL_CALLS_PER_TURN = 8;
export const AGENT_TOOL_RESULT_MAX_CHARS = 12000; // per tool result fed back

// ── Tool catalogue ───────────────────────────────────────────────────────────
// One OpenAI function per built-in capability. The model sees exactly these;
// execution is in runAgentTools.js. Kept JSON-schema-shaped so any OpenAI-
// compatible client can also send them verbatim.
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information. Returns up to 8 results with title, url, and snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch and read a web page (or search + page in one step when only a query is given).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The page URL to read." },
          query: { type: "string", description: "Optional: search this and fetch the top result instead of a literal URL." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_gen",
      description: "Generate an image from a text prompt. Returns a URL or base64 of the image.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to draw." },
          width: { type: "number", description: "Optional width in px." },
          height: { type: "number", description: "Optional height in px." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tts",
      description: "Convert text to speech. Returns an audio URL/data-uri.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to speak." },
          voice: { type: "string", description: "Optional voice name." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stt",
      description: "Transcribe audio to text. Provide an audio URL or data-uri.",
      parameters: {
        type: "object",
        properties: {
          audio: { type: "string", description: "Audio URL or base64 data-uri." },
          language: { type: "string", description: "Optional hint, e.g. \"en\"." },
        },
        required: ["audio"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embeddings",
      description: "Compute embedding vectors for text. Returns the vector array.",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "The text to embed." },
        },
        required: ["input"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "video_gen",
      description: "Generate a short video from a text prompt. Returns a video URL.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Describe the video." },
        },
        required: ["prompt"],
      },
    },
  },
];

// The tool names, for capability checks / logging.
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.function.name);
