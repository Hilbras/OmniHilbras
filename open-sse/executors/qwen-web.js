import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { browserFingerprintHeaders, cookieHeaderFrom, parseCookieHeader, readBodyRefusal } from "../shared/webSession/common.js";

/**
 * Qwen Web — chat.qwen.ai reached with the session a signed-in browser holds.
 *
 * Ported from the previous project's `providers/qwen-web`, which established the
 * request shape against the live site. The measurements that decided the code:
 *
 * - The turn endpoint is a plain, unminified `POST /api/v2/chat/completions` on the
 *   chat origin, and it speaks an OpenAI-shaped body: `{ model, messages, stream }`.
 * - **A refusal arrives with HTTP 200 and the refusal in the body.** Qwen's
 *   bot-protection gate answers `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::…"],
 *   "data":{"url":"…/_____tmd_____/punish?…"}}` and the status says success, so a
 *   client that checks only the status sees a working provider. Every refusal here
 *   is read out of the body.
 * - That `_____tmd_____/punish` URL is **not a clearance flow**: requesting it
 *   returns 200, renders "Please connect them in order", sets no cookie, and the
 *   retry is refused with a freshly minted challenge. It is a human puzzle, so a
 *   client cannot satisfy it — which is why the refusal is reported in the
 *   provider's own words instead of being retried.
 * - Qwen's gateway fingerprints the client, so the request carries the web app's
 *   own headers (origin, referer, sec-ch-ua, the browser's user agent).
 *
 * The response this executor returns is an **OpenAI chat-completions** body — an
 * SSE stream when the client asked for one, a JSON object when it did not. The
 * translator layer pivots through OpenAI, so no translator is needed for this
 * provider: the shape below is the contract.
 */

const QWEN_TURN_URL = PROVIDERS["qwen-web"]?.baseUrl || null;

/** The chat origin, taken off the registry's endpoint so it is stated once. */
function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const QWEN_ORIGIN = originOf(QWEN_TURN_URL);

const PROMPT_TOKEN_ESTIMATE = 4;

/**
 * The Cookie header for a stored credential.
 *
 * The paste is a whole `Cookie:` header value (`name=value; name2=value2`), so it
 * is parsed and rebuilt rather than passed through: a lone `name=value` and a
 * header with odd spacing are both legal pastes, and the service is happier with
 * one canonical form.
 *
 * Fail-open on a parse failure: a stored credential the parser does not recognise
 * is still worth sending verbatim, because the service — not this parser — decides
 * whether a session is good.
 */
function cookieHeaderFor(credentials) {
  const raw = String(credentials?.apiKey || credentials?.accessToken || "").trim();
  if (!raw) return "";
  try {
    return cookieHeaderFrom(parseCookieHeader(raw));
  } catch {
    return raw;
  }
}

/** The role names the web app understands. `developer` is OpenAI's newer spelling of `system`. */
function normalizeRole(role) {
  const name = String(role || "user").toLowerCase();
  if (name === "developer") return "system";
  if (name === "system" || name === "user" || name === "assistant") return name;
  // The web chat has no tool channel. A tool result is kept as a plain turn rather
  // than dropped, because the answer it produced is usually still in the
  // conversation and throwing it away loses the thread.
  if (name === "tool" || name === "function") return "user";
  return null;
}

/** Flattens OpenAI message content to text. Images are not sent: the web chat has no image channel. */
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content.text === "string") return content.text;
  return "";
}

/**
 * The request body for a turn.
 *
 * The shape is the one the previous project measured against the live endpoint:
 * `{ model, messages, stream }` and nothing else. Adding fields the endpoint does
 * not expect is how a request starts being answered with a refusal instead of an
 * answer, so the payload is kept to what is known to work.
 */
export function buildQwenRequestBody(model, messages, stream) {
  return {
    model,
    messages: toQwenMessages(messages),
    stream: Boolean(stream),
  };
}

/** OpenAI messages → the web app's transcript. */
export function toQwenMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const msg of messages) {
    const role = normalizeRole(msg?.role);
    if (!role) continue;
    const content = flattenContent(msg?.content);
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out;
}

/** The provider's own refusal, read out of a **200**. */
export function readQwenRefusal(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const ret = Array.isArray(payload.ret) ? payload.ret : [];
  if (ret.length > 0) return `Qwen refused the turn: ${ret.join(", ")}`;
  const refusal = readBodyRefusal(payload);
  return refusal ? `Qwen refused the turn: ${refusal}` : undefined;
}

/**
 * The bot-protection challenge URL, when the refusal carries one.
 *
 * Worth naming in the error: it is the difference between "your session is wrong"
 * and "the provider wants a human to solve a puzzle", and the second one cannot be
 * fixed by re-pasting a cookie.
 */
export function readQwenGateUrl(payload) {
  const url = payload?.data?.url;
  return typeof url === "string" && url.includes("_____tmd_____/punish") ? url : null;
}

/**
 * A refusal, with the challenge URL explained when there is one.
 *
 * The wording is the provider's own wherever possible: a summary of a refusal is a
 * guess about what the provider meant, and the whole point of reading the body
 * rather than the status is that the provider is the one who knows.
 */
export function describeQwenRefusal(payload) {
  const refusal = readQwenRefusal(payload);
  if (!refusal) return undefined;
  const gate = readQwenGateUrl(payload);
  if (!gate) return refusal;
  return `${refusal} The provider answered with a bot-protection challenge (${gate}); requesting it grants no cookie, so this is a puzzle for a person and not a clearance flow.`;
}

/**
 * The status a refusal is reported with.
 *
 * A refused credential is a 401; a refused *request* — the bot-protection gate —
 * is a 403. Both arrive as HTTP 200, so the status has to be chosen from what the
 * body said rather than read off the response.
 */
export function refusalStatus(message) {
  const text = String(message || "").toLowerCase();
  if (/unauthor|unauthentic|401|expired|invalid (token|credential|cookie)/.test(text)) return 401;
  return 403;
}

/** Text out of a content field that may be a string or an array of parts. */
function readText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

/**
 * The assistant text carried by one upstream payload.
 *
 * `cumulative` says the payload holds the whole answer so far rather than an
 * increment — some streams send the full message in every frame, and appending
 * those would repeat the answer N times.
 */
export function readQwenMessage(payload) {
  const roots = [payload, payload?.data].filter((root) => root && typeof root === "object");
  for (const root of roots) {
    const choice = Array.isArray(root.choices) ? root.choices[0] : null;
    if (choice) {
      const delta = readText(choice?.delta?.content);
      const message = readText(choice?.message?.content);
      const text = delta || message || readText(choice?.text);
      const reasoning =
        readText(choice?.delta?.reasoning_content) || readText(choice?.message?.reasoning_content);
      if (text || reasoning) {
        return { text, reasoning, cumulative: !delta && !!message, finishReason: choice?.finish_reason || null };
      }
    }
    const direct = readText(root?.content) || readText(root?.output_text);
    if (direct) return { text: direct, reasoning: "", cumulative: false, finishReason: null };
  }
  return { text: "", reasoning: "", cumulative: false, finishReason: null };
}

/** Token usage, when the provider sent any. */
export function readQwenUsage(payload) {
  const usage = payload?.usage || payload?.data?.usage;
  if (!usage || typeof usage !== "object") return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  if (prompt == null && completion == null) return null;
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: usage.total_tokens ?? (prompt ?? 0) + (completion ?? 0),
  };
}

/**
 * Reads the upstream body.
 *
 * Yields the JSON payloads of an SSE stream, and yields the whole body as one
 * payload when the answer was not a stream at all — the endpoint answers a
 * non-streaming request with plain JSON, and a client that asked for a stream is
 * still owed an answer.
 */
async function* readQwenEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let sawData = false;

  const parse = (rawPayload) => {
    const trimmed = rawPayload.trim();
    if (!trimmed || trimmed === "[DONE]") return trimmed === "[DONE]" ? "done" : null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("data:")) {
          sawData = true;
          const parsed = parse(trimmed.slice(5));
          if (parsed === "done") return;
          if (parsed) yield parsed;
          continue;
        }
        if (!sawData) raw += line + "\n";
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      if (tail.startsWith("data:")) {
        const parsed = parse(tail.slice(5));
        if (parsed === "done") return;
        if (parsed) yield parsed;
      } else if (!sawData) {
        raw += tail;
      }
    }
    if (!sawData && raw.trim()) {
      const parsed = parse(raw);
      if (parsed && parsed !== "done") yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The already-read first payload, then the rest of the stream. */
async function* iterateWithFirst(events, firstPayload) {
  if (firstPayload !== undefined) yield firstPayload;
  for await (const payload of events) yield payload;
}

function errorResponse(message, status, code, type = "upstream_error") {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The finish reasons a client understands; anything else is the provider's own vocabulary. */
const OPENAI_FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls"]);

function buildStreamingResponse(events, firstPayload, model, cid, created) {
  const encoder = new TextEncoder();
  const chunk = (delta, finishReason = null, extra = {}) =>
    encoder.encode(
      sseChunk({
        id: cid,
        object: "chat.completion.chunk",
        created,
        model,
        system_fingerprint: null,
        choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
        ...extra,
      }),
    );

  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(chunk({ role: "assistant" }));

        let full = "";
        let usage = null;
        let finishReason = "stop";

        for await (const payload of iterateWithFirst(events, firstPayload)) {
          const refusal = describeQwenRefusal(payload);
          if (refusal) {
            controller.enqueue(chunk({ content: `[Error: ${refusal}]` }));
            break;
          }
          const seen = readQwenUsage(payload);
          if (seen) usage = seen;
          const { text, reasoning, cumulative, finishReason: upstreamFinish } = readQwenMessage(payload);
          if (upstreamFinish && OPENAI_FINISH_REASONS.has(upstreamFinish)) finishReason = upstreamFinish;
          if (reasoning) controller.enqueue(chunk({ reasoning_content: reasoning }));
          if (!text) continue;
          if (cumulative) {
            // The frame carries the whole answer so far: emit only what is new.
            const delta = full && text.startsWith(full) ? text.slice(full.length) : text;
            full = text;
            if (delta) controller.enqueue(chunk({ content: delta }));
            continue;
          }
          full += text;
          controller.enqueue(chunk({ content: text }));
        }

        controller.enqueue(chunk({}, finishReason, usage ? { usage } : {}));
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(chunk({ content: `[Stream error: ${err?.message || String(err)}]` }, "stop"));
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });
}

async function buildNonStreamingResponse(events, firstPayload, model, cid, created, promptChars = 0) {
  let full = "";
  const reasoningParts = [];
  let usage = null;
  let refusal;
  let finishReason = "stop";

  for await (const payload of iterateWithFirst(events, firstPayload)) {
    const said = describeQwenRefusal(payload);
    if (said) {
      refusal = said;
      break;
    }
    const seen = readQwenUsage(payload);
    if (seen) usage = seen;
    const { text, reasoning, cumulative, finishReason: upstreamFinish } = readQwenMessage(payload);
    if (upstreamFinish && OPENAI_FINISH_REASONS.has(upstreamFinish)) finishReason = upstreamFinish;
    if (reasoning) reasoningParts.push(reasoning);
    if (!text) continue;
    full = cumulative ? text : full + text;
  }

  if (refusal) {
    return errorResponse(refusal, refusalStatus(refusal), "QWEN_REFUSED");
  }

  const message = { role: "assistant", content: full };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");

  const counted = usage || {
    prompt_tokens: Math.ceil(promptChars / PROMPT_TOKEN_ESTIMATE),
    completion_tokens: Math.ceil(full.length / PROMPT_TOKEN_ESTIMATE),
    total_tokens: Math.ceil((promptChars + full.length) / PROMPT_TOKEN_ESTIMATE),
  };

  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      system_fingerprint: null,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      usage: counted,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export class QwenWebExecutor extends BaseExecutor {
  constructor() {
    super("qwen-web", PROVIDERS["qwen-web"]);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return QWEN_TURN_URL;
  }

  buildHeaders(credentials, stream = true) {
    const headers = browserFingerprintHeaders({
      origin: QWEN_ORIGIN,
      referer: QWEN_ORIGIN ? `${QWEN_ORIGIN}/` : undefined,
      accept: stream ? "text/event-stream" : "application/json",
      extra: { "content-type": "application/json" },
    });
    const cookie = cookieHeaderFor(credentials);
    if (cookie) headers.cookie = cookie;
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    return buildQwenRequestBody(model, body?.messages, stream);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const url = this.buildUrl(model, stream, 0, credentials);

    if (!url) {
      // The provider is not wired into the registry index yet. Answering is
      // better than throwing: the gateway stays up and the log says why.
      const errResp = errorResponse(
        "Qwen Web has no endpoint registered. The provider entry is missing from the registry.",
        500,
        "QWEN_NOT_REGISTERED",
        "invalid_request",
      );
      return { response: errResp, url: null, headers: {}, transformedBody: body };
    }

    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      const errResp = errorResponse("Missing or empty messages array", 400, "QWEN_NO_MESSAGES", "invalid_request");
      return { response: errResp, url, headers: {}, transformedBody: body };
    }

    const headers = this.buildHeaders(credentials, stream);
    if (!headers.cookie) {
      const errResp = errorResponse(
        "This connection has no Qwen Web session cookie. Re-paste the Cookie header from auth.qwen.ai.",
        401,
        "QWEN_NO_CREDENTIAL",
        "invalid_request",
      );
      return { response: errResp, url, headers, transformedBody: body };
    }

    const transformedBody = this.transformRequest(model, body, stream, credentials);
    if (transformedBody.messages.length === 0) {
      const errResp = errorResponse("Empty query after processing", 400, "QWEN_EMPTY_QUERY", "invalid_request");
      return { response: errResp, url, headers, transformedBody };
    }

    log?.info?.(
      "QWEN-WEB",
      `Turn to ${model} (stream=${Boolean(stream)}), ${transformedBody.messages.length} messages`,
    );

    let response;
    try {
      response = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal,
      });
    } catch (err) {
      log?.error?.("QWEN-WEB", `Fetch failed: ${err?.message || String(err)}`);
      const errResp = errorResponse(
        `Qwen Web connection failed: ${err?.message || String(err)}`,
        502,
        "QWEN_UNREACHABLE",
      );
      return { response: errResp, url, headers, transformedBody };
    }

    if (!response.ok) {
      const status = response.status;
      let message = `Qwen returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        message = "Qwen refused the session — the cookie from auth.qwen.ai is expired or was not accepted. Re-paste it.";
      } else if (status === 429) {
        message = "Qwen rate limited the session. Wait a moment and retry.";
      }
      log?.warn?.("QWEN-WEB", message);
      const errResp = errorResponse(message, status, `HTTP_${status}`);
      return { response: errResp, url, headers, transformedBody };
    }

    if (!response.body) {
      const errResp = errorResponse("Qwen returned an empty response body", 502, "QWEN_EMPTY_BODY");
      return { response: errResp, url, headers, transformedBody };
    }

    const cid = `chatcmpl-qwen-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    const events = readQwenEvents(response.body, signal);

    /**
     * The first frame is read before the response is built.
     *
     * A refusal arrives as HTTP 200 with the refusal in the body, and it is the
     * first thing the provider sends. Catching it here is the difference between a
     * client that gets a real error status and a client that gets a 200 whose
     * first token says "[Error: …]".
     */
    const first = await events.next();
    const firstPayload = first.done ? undefined : first.value;
    const firstRefusal = firstPayload ? describeQwenRefusal(firstPayload) : undefined;
    if (firstRefusal) {
      log?.warn?.("QWEN-WEB", firstRefusal);
      // The upstream body is still open: closing the reader releases the lock and
      // lets the connection go, instead of leaving it hanging on a response the
      // client is never going to read.
      await events.return?.();
      const errResp = errorResponse(firstRefusal, refusalStatus(firstRefusal), "QWEN_REFUSED");
      return { response: errResp, url, headers, transformedBody };
    }

    const finalResponse = stream
      ? new Response(buildStreamingResponse(events, firstPayload, model, cid, created), {
          status: 200,
          headers: { ...SSE_HEADERS_NO_BUFFER },
        })
      : await buildNonStreamingResponse(
          events,
          firstPayload,
          model,
          cid,
          created,
          transformedBody.messages.map((m) => m.content).join("\n").length,
        );

    return { response: finalResponse, url, headers, transformedBody };
  }
}

export default QwenWebExecutor;
