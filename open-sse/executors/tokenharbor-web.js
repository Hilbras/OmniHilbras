import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import tokenHarborWebEntry from "../providers/registry/tokenharbor-web.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { browserFingerprintHeaders, BROWSER_TIMEZONE } from "../shared/webSession/common.js";
import {
  parseTokenHarborCookie,
  refusalFor,
} from "../shared/webSession/tokenharbor-web.js";
import { FORMATS } from "../translator/formats.js";

/**
 * Token Harbor Web — the chat application at tokenharbor.ai, driven by the
 * Supabase session cookie a signed-in browser already holds.
 *
 * ## A turn is two requests and a decode
 *
 * 1. `POST /api/direct-chat/sessions` with `{ model, temporary: true }` →
 *    `{ session: { id } }`. `temporary` is sent so a stateless gateway does not
 *    litter the user's sidebar with a conversation per request.
 * 2. `POST /api/direct-chat/stream` with
 *    `{ sessionId, content, model, webSearch, tz }` → an SSE body whose events
 *    are **named**, not OpenAI's `choices[].delta`:
 *
 *    ```text
 *    event: chunk
 *    data: {"delta":"working"}
 *
 *    event: thinking
 *    data: {"delta":"..."}
 *
 *    event: done
 *    data: {}
 *    ```
 *
 *    `chunk` is the answer text and `thinking` is the reasoning, split into
 *    their own events — so a model that thinks before answering does not have
 *    its reasoning read as the reply. `error` carries `{ code, message }`.
 *
 * The whole body is read and then emitted as one OpenAI-shaped answer. The
 * upstream is an SSE stream, but a turn here is read whole on purpose: the
 * `done` event is what makes a truncated body *detectable*, and a body that
 * closes without it was cut off mid-generation. Reporting the fragment as a
 * clean `stop` is the worst version — it looks like a model that finished and
 * the ending is silently missing.
 */

/**
 * The endpoints and the model catalog, read from the registry entry so no URL
 * is spelled twice.
 *
 * The entry file is read directly rather than through the `PROVIDERS` barrel:
 * that barrel is built from a generated static-import list, and a provider
 * whose entry has not been added to that list yet would otherwise have no
 * endpoint at all.
 */
const TRANSPORT = tokenHarborWebEntry.transport || {};
const MODELS = tokenHarborWebEntry.models || [];

/**
 * The model a request that names none is answered with.
 *
 * A free one, read from the catalog rather than spelled out here: the list of
 * free models is the catalog's business, and a hardcoded id is one more thing
 * to forget when it rotates.
 */
function defaultModelId() {
  const free = MODELS.find((entry) => String(entry.id).endsWith(":free"));
  return free?.id || MODELS[0]?.id || "";
}

/**
 * The conversation, as the one string the stream endpoint takes.
 *
 * Labelled rather than concatenated: a bare join of `["You are terse.", "2+2?"]`
 * loses which was which, and the model then answers as if the instruction were
 * part of the question.
 *
 * A system turn is lifted out of the conversation and framed as an
 * instruction, and a client that keeps its system prompt beside the messages
 * (Claude's shape) is read as well as one that puts it in the list.
 */
export function flattenMessages(messages, systemText) {
  const kept = (Array.isArray(messages) ? messages : [])
    .map((message) => ({ role: message?.role, text: messageText(message?.content).trim() }))
    .filter((message) => message.text);
  const system = kept.filter((message) => message.role === "system");
  const rest = kept.filter((message) => message.role !== "system");
  const lines = [];
  if (system.length > 0) {
    lines.push("Follow these instructions:", ...system.map((message) => `- ${message.text}`), "");
  }
  const aside = typeof systemText === "string" ? systemText.trim() : "";
  if (aside) {
    lines.push("Follow these instructions:", `- ${aside}`, "");
  }
  for (const message of rest) {
    lines.push(`${message.role === "assistant" ? "Assistant" : "User"}: ${message.text}`);
  }
  return lines.join("\n").trim();
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
      return "";
    })
    .join("");
}

/**
 * Reads a completed answer out of Token Harbor's named-event SSE body.
 *
 * Only `chunk`, `thinking`, `done` and `error` are consumed. The other events
 * — `tool_use`, `citation`, `image`, `file`, `miniapp` — are attachments and
 * citations for a UI, and inventing an OpenAI shape for them here would be
 * guessing at a contract this adapter cannot test without the session.
 *
 * **`done` is what makes a truncated body detectable.** A stream that closes
 * without it was cut off, and the caller reports that instead of handing back
 * half an answer labelled complete.
 */
export function decodeTokenHarborStream(body) {
  let content = "";
  let reasoning = "";
  let finished = false;
  let error;

  for (const block of String(body || "").split("\n\n")) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) {
      if (event === "done") finished = true;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (event === "error") {
      error = {
        code: typeof parsed.code === "string" ? parsed.code : "error",
        message: typeof parsed.message === "string" ? parsed.message : "Token Harbor refused the turn.",
      };
      continue;
    }
    const delta = typeof parsed.delta === "string" ? parsed.delta : "";
    if (!delta) {
      if (event === "done") finished = true;
      continue;
    }
    if (event === "thinking") reasoning += delta;
    else if (event === "chunk") content += delta;
    if (event === "done") finished = true;
  }

  return { content, reasoning, finished, ...(error ? { error } : {}) };
}

/**
 * The credential, as a `Cookie:` header value.
 *
 * The connection stores the normalized header, so this is normally a
 * pass-through. A connection made by hand through the API can hold a raw
 * paste, so it is normalized here when it can be — and passed through
 * untouched when it cannot, because the upstream refusing it is a better
 * answer than this layer guessing.
 */
function credentialCookie(credentials) {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  try {
    return parseTokenHarborCookie(raw);
  } catch {
    return raw;
  }
}

/**
 * The model id to ask for, or `null` when the catalog does not list it.
 *
 * An empty model falls back to the free default, the way the previous
 * implementation did — a request that names no model is a request for the
 * cheapest one, not a bad request.
 */
function resolveModelId(model) {
  const wanted = String(model || "").trim();
  if (!wanted) return defaultModelId();
  if (MODELS.length === 0) return wanted;
  const found = MODELS.find((entry) => String(entry.id).toLowerCase() === wanted.toLowerCase());
  return found ? found.id : null;
}

/** A JSON error body, in the shape the gateway's error reader expects. */
function errorResponse(status, message, code, type) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: type || "upstream_error",
        code: code || `HTTP_${status}`,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** The error code that goes with a status, so routing can act on it. */
function codeForStatus(status) {
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 402) return "PROVIDER_REQUEST_FAILED";
  return `HTTP_${status}`;
}

/**
 * Reads the body with a hard cap.
 *
 * An SSE body from a proxy that never closes is an unbounded read, and a cap
 * that silently truncates is worse than one that refuses — so the cap throws
 * and the caller reports it.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readBodyCapped(response) {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Token Harbor's reply exceeded ${MAX_RESPONSE_BYTES} bytes and was refused rather than truncated.`,
    );
  }
  return new TextDecoder().decode(buffer);
}

/**
 * The OpenAI chat-completions SSE stream.
 *
 * One answer, delivered in the shape every client downstream already
 * understands — the translator turns it into whatever the client speaks.
 */
function buildStreamingResponse({ content, reasoning, model, cid, created }) {
  const encoder = new TextEncoder();
  const frame = (delta, finishReason = null) =>
    sseChunk({
      id: cid,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: null,
      choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    });

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frame({ role: "assistant" })));
        if (reasoning) {
          controller.enqueue(encoder.encode(frame({ reasoning_content: reasoning })));
        }
        if (content) {
          controller.enqueue(encoder.encode(frame({ content })));
        }
        controller.enqueue(encoder.encode(frame({}, "stop")));
        controller.enqueue(encoder.encode(SSE_DONE));
        controller.close();
      },
    }),
    { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } },
  );
}

/** The OpenAI chat-completions body. */
function buildJsonResponse({ content, reasoning, model, cid, created, promptTokens }) {
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;

  // The upstream reports no token counts, so they are estimated the way the
  // sibling web providers estimate them: four characters to a token.
  const completionTokens = Math.ceil(content.length / 4);

  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
      choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export class TokenHarborWebExecutor extends BaseExecutor {
  constructor() {
    super("tokenharbor-web", PROVIDERS["tokenharbor-web"] || TRANSPORT);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return TRANSPORT.streamUrl || TRANSPORT.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const cookie = credentialCookie(credentials);
    const origin = TRANSPORT.origin;
    return {
      ...browserFingerprintHeaders({
        origin,
        referer: origin ? `${origin}/chat` : undefined,
        accept: "text/event-stream, application/json",
      }),
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    };
  }

  /**
   * The turn's payload.
   *
   * `sessionId` is left empty here and filled in by `execute()`, once the
   * temporary session exists — the endpoint wants a session, and a session is
   * something the service has to have created first.
   */
  transformRequest(model, body, stream, credentials) {
    return {
      sessionId: "",
      content: flattenMessages(body?.messages, body?.system),
      model,
      webSearch: "auto",
      // The browser-shaped timezone the shared web-session helpers carry. The
      // upstream reads it as "where the user is", and a value that disagrees
      // with the one the rest of the request claims is a question the
      // anti-bot layer may ask.
      tz: BROWSER_TIMEZONE,
    };
  }

  /**
   * The turn.
   *
   * Every failure leaves here as a `Response`: an executor that throws turns a
   * provider's own message into "every provider route failed", which throws
   * away the one thing the user can act on. The catch below is the last line
   * of that defence — nothing leaves this method as an exception.
   */
  async execute(args) {
    try {
      return await this.#turn(args);
    } catch (error) {
      const message = `Token Harbor Web failed: ${error?.message || String(error)}`;
      args?.log?.error?.("TOKENHARBOR-WEB", message);
      return {
        response: errorResponse(502, message, "PROVIDER_UNAVAILABLE"),
        url: TRANSPORT.streamUrl || TRANSPORT.baseUrl,
        headers: {},
        transformedBody: args?.body,
      };
    }
  }

  async #turn({ model, body, stream, credentials, signal, log }) {
    const headers = this.buildHeaders(credentials, stream);
    const streamUrl = this.buildUrl(model, stream, 0, credentials);
    const sessionsUrl = TRANSPORT.sessionsUrl;

    const fail = (status, message, code, type) => ({
      response: errorResponse(status, message, code, type),
      url: streamUrl,
      headers,
      transformedBody: body,
    });

    if (!streamUrl || !sessionsUrl) {
      return fail(503, "Token Harbor Web is not configured in this build.", "PROVIDER_UNAVAILABLE");
    }

    const cookie = headers.Cookie;
    if (!cookie) {
      return fail(
        401,
        "This Token Harbor Web connection has no session cookie. Sign in again and paste a fresh one.",
        "AUTHENTICATION_FAILED",
        "authentication_error",
      );
    }

    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return fail(400, "Missing or empty messages array", "INVALID_REQUEST", "invalid_request");
    }

    const modelId = resolveModelId(model);
    if (!modelId) {
      return fail(
        400,
        `Token Harbor Web does not offer a model called ${model}. The models it serves are the ones on this page.`,
        "NOT_SUPPORTED",
        "invalid_request",
      );
    }

    // 1. The session. `temporary` keeps the conversation out of the user's
    //    sidebar: a gateway request is not a chat they opened, and one row per
    //    API call is a side effect nobody asked for.
    let sessionResponse;
    try {
      sessionResponse = await proxyAwareFetch(
        sessionsUrl,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ model: modelId, temporary: true }),
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      const message = `Token Harbor connection failed: ${error?.message || String(error)}`;
      log?.error?.("TOKENHARBOR-WEB", message);
      return fail(502, message, "PROVIDER_UNAVAILABLE");
    }

    if (!sessionResponse.ok) {
      const message = refusalFor(sessionResponse.status, "starting a chat session", cookie);
      log?.warn?.("TOKENHARBOR-WEB", message);
      return fail(sessionResponse.status, message, codeForStatus(sessionResponse.status));
    }

    const sessionJson = await sessionResponse.json().catch(() => ({}));
    const sessionId = sessionJson?.session?.id;
    if (typeof sessionId !== "string" || !sessionId) {
      return fail(502, "Token Harbor started no chat session.", "PROVIDER_REQUEST_FAILED");
    }

    // 2. The turn.
    const payload = { ...this.transformRequest(modelId, body, stream, credentials), sessionId };
    if (!payload.content) {
      return fail(400, "There is no message to send to Token Harbor Web.", "INVALID_REQUEST", "invalid_request");
    }

    let turnResponse;
    try {
      turnResponse = await proxyAwareFetch(
        streamUrl,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      const message = `Token Harbor connection failed: ${error?.message || String(error)}`;
      log?.error?.("TOKENHARBOR-WEB", message);
      return fail(502, message, "PROVIDER_UNAVAILABLE");
    }

    if (!turnResponse.ok) {
      const message = refusalFor(turnResponse.status, "answering the completion", cookie);
      log?.warn?.("TOKENHARBOR-WEB", message);
      return fail(turnResponse.status, message, codeForStatus(turnResponse.status));
    }

    // 3. The answer.
    let raw;
    try {
      raw = await readBodyCapped(turnResponse);
    } catch (error) {
      return fail(502, error?.message || String(error), "PROVIDER_REQUEST_FAILED");
    }

    const answer = decodeTokenHarborStream(raw);
    if (answer.error) {
      const unauthorized = answer.error.code === "unauthorized";
      return fail(
        unauthorized ? 401 : 502,
        `Token Harbor refused the turn: ${answer.error.message}`,
        unauthorized ? "AUTHENTICATION_FAILED" : "PROVIDER_REQUEST_FAILED",
        unauthorized ? "authentication_error" : "upstream_error",
      );
    }
    if (!answer.content && !answer.reasoning) {
      return fail(
        502,
        "Token Harbor answered, but the stream carried no text. Its response format may have changed.",
        "PROVIDER_REQUEST_FAILED",
      );
    }
    if (!answer.finished) {
      // A body that closes without `done` was cut off mid-generation.
      // Reporting the fragment as a clean `stop` is the worst version: it
      // looks like a model that finished and the ending is silently missing.
      return fail(
        502,
        `Token Harbor's stream ended before it finished — the answer was cut off after ${answer.content.length} characters. This is usually a dropped connection or an expired session. Try again.`,
        "PROVIDER_REQUEST_FAILED",
      );
    }

    const cid = `chatcmpl-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}`;
    const created = Math.floor(Date.now() / 1000);
    const response = stream
      ? buildStreamingResponse({ content: answer.content, reasoning: answer.reasoning, model: modelId, cid, created })
      : buildJsonResponse({
          content: answer.content,
          reasoning: answer.reasoning,
          model: modelId,
          cid,
          created,
          promptTokens: Math.ceil(payload.content.length / 4),
        });

    return {
      response,
      url: streamUrl,
      headers,
      transformedBody: payload,
      // The body above is OpenAI's, whatever the client asked for — the
      // translator turns it into the client's own format.
      responseFormat: FORMATS.OPENAI,
    };
  }
}

export default TokenHarborWebExecutor;
