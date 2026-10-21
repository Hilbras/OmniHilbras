import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import registryEntry from "../providers/registry/duckduckgo-web.js";
import {
  DUCKDUCKGO_WEB,
  DuckDuckGoWebError,
  buildDuckDuckGoWebPayload,
  duckDuckGoCatalog,
  duckDuckGoWebContent,
  duckDuckGoWebCookieHeader,
  duckDuckGoHeaders,
  duckDuckGoTurn,
  freeDuckDuckGoWebModels,
  publicKeyJwk,
  readDuckDuckGoEvents,
} from "../shared/webSession/duckduckgo-web.js";

/**
 * The transport, read from the registry entry.
 *
 * The registry index is generated, so the entry itself is the source of truth and the built map is only a
 * convenience — reading the entry keeps this executor working before the index is regenerated.
 */
const DDG_TRANSPORT = PROVIDERS["duckduckgo-web"] || registryEntry.transport;

/**
 * The error each failure kind is reported as.
 *
 * The codes are the ones the previous project settled on, and the classification reads the service's own `type`
 * field rather than its prose: `ERR_CHALLENGE` and `ERR_BN_LIMIT` share a user-facing message token, so a regex
 * over the message would classify a per-address quota as an expired challenge — and only one of those is worth
 * waiting out.
 */
const ERROR_CODES = {
  challenge: "PROVIDER_UNAVAILABLE",
  quota: "PROVIDER_UNAVAILABLE",
  "rate-limit": "PROVIDER_REQUEST_FAILED",
  "bad-request": "INVALID_REQUEST",
  unavailable: "PROVIDER_REQUEST_FAILED",
};

/**
 * What a person can act on, per kind.
 *
 * The sentences are the previous project's, kept because each one names a *different* action: a challenge is
 * "wait", a quota is "this address", a rate limit is "later", a malformed request is "look at the field", and
 * an unreachable service is "probably the network". A single generic sentence would lose all five.
 */
const PUBLIC_MESSAGES = {
  challenge:
    "Duck.ai refused the request at its anti-bot check. That usually means too many requests from this address in a short window — waiting a few minutes is the fix, not retrying, and not re-pasting a cookie.",
  quota:
    "Duck.ai is refusing this address rather than this request. A pasted cookie can help and is optional; a request from a different address may work immediately.",
  "rate-limit": "Duck.ai is rate limiting this address. Retrying later is the fix.",
  "bad-request": "Duck.ai refused the request as malformed. See the message for which field.",
  unavailable:
    "Duck.ai could not be reached. If this is a network problem on the gateway host it will work again on its own; if it keeps happening, the service may have changed.",
};

/** The text of one message, whether it is a string or a list of content parts. */
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

/** The conversation, in the shape the service takes: a role and a string. */
function toDuckDuckGoMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: String(message?.role || "user"),
    content: messageText(message?.content),
  }));
}

/** An error body in the shape the gateway's clients read. */
function errorResponse(message, type, status, code) {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The answer, streamed out as OpenAI chat-completion chunks.
 *
 * The upstream really does send the answer frame by frame, so the frames are handed on as they arrive rather
 * than assembled first. The one thing that is *not* streamed is the refusal: a 200 with no text in it is a
 * failure, and it is reported as one.
 */
function buildStreamingResponse(upstreamBody, model, cid, created, signal) {
  const encoder = new TextEncoder();
  const chunk = (delta, finishReason = null) =>
    sseChunk({
      id: cid,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: null,
      choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    });

  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(chunk({ role: "assistant" })));

        let fullAnswer = "";
        for await (const event of readDuckDuckGoEvents(upstreamBody, signal)) {
          const text = duckDuckGoWebContent(event);
          if (!text) continue;
          fullAnswer += text;
          controller.enqueue(encoder.encode(chunk({ content: text })));
        }

        // A 200 with no text is not success. The service says `{"action":"success","message":"OK"}` before the
        // answer, so a reader that returned early on the first frame reports an empty answer as a completed turn.
        if (!fullAnswer) {
          controller.enqueue(
            encoder.encode(chunk({ content: "[Error: Duck.ai answered 200 with no text in the stream]" }, "stop")),
          );
        } else {
          controller.enqueue(encoder.encode(chunk({}, "stop")));
        }
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(
          encoder.encode(chunk({ content: `[Error: ${err.message || String(err)}]` }, "stop")),
        );
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });
}

/** The answer, assembled into one OpenAI chat-completion object. */
async function buildNonStreamingResponse(upstreamBody, model, cid, created, promptText, signal) {
  let fullAnswer = "";
  let answered = model;
  for await (const event of readDuckDuckGoEvents(upstreamBody, signal)) {
    if (typeof event.model === "string" && event.model) answered = event.model;
    fullAnswer += duckDuckGoWebContent(event);
  }

  if (!fullAnswer) {
    return errorResponse(
      "Duck.ai answered 200 with no text in the stream",
      "upstream_error",
      502,
      ERROR_CODES.unavailable,
    );
  }

  const promptTokens = Math.ceil(promptText.length / 4);
  const completionTokens = Math.ceil(fullAnswer.length / 4);

  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model: answered,
      system_fingerprint: null,
      choices: [{ index: 0, message: { role: "assistant", content: fullAnswer }, finish_reason: "stop", logprobs: null }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Duck.ai, over HTTP.
 *
 * ## What this executor is, and what it is not
 *
 * It is not a browser driver, unlike the other web-session providers. duck.ai's chat is a JSON/SSE endpoint, so
 * the only thing standing between this gateway and an answer is an anti-bot challenge — solved with `node:vm` in
 * the shared module, which is why that half lives there: the dashboard's credential check has to solve the same
 * challenge, and one solver in one place is the only way the two cannot drift apart.
 *
 * ## Measured, once, by hand, before any of this was written
 *
 * `POST /duckchat/v1/chat` → **200**, `text/event-stream`, and the answer that was asked for, on the first
 * attempt, from this host. Three things that measurement settled and this executor depends on:
 *
 * - **The delta is in `message`.** `content` never appears. A reader looking for `content` gets a 200 with an
 *   empty answer.
 * - **`x-fe-version` must be assembled** from `data-version-tag` and `data-version-sha`. The source
 *   implementation searched for the joined string, never found it, and sent a hardcoded version from an earlier
 *   release on every request. A page missing either attribute **refuses the turn**, because a stale version is
 *   worse than none — it looks like a measurement.
 * - **418 is not one thing.** A `418 ERR_CHALLENGE` arrived 43 s after a successful turn, with a byte-identical
 *   request, and the same request succeeded 4.9 min later. The leading explanation is a short per-address quota
 *   rather than a solver fault, and the consequence is behavioural: **back off, do not retry.**
 *
 * ## Not established, and not claimed
 *
 * - Whether `reasoningEffort` is strictly required. The source records a 400 without it, verified on its side;
 *   re-measuring costs a chat POST, so the requests that succeeded are the evidence and they all sent it.
 * - Whether the rotated `x-vqd-hash-1` on a chat response is reusable. **Not implemented**: a fresh challenge is
 *   fetched per turn, which costs one extra GET and cannot be wrong.
 * - Which headers are strictly necessary. Ablating them costs chat POSTs, so this sends the set that returned 200
 *   and says so rather than implying it is minimal.
 */
export class DuckDuckGoWebExecutor extends BaseExecutor {
  constructor() {
    super("duckduckgo-web", DDG_TRANSPORT);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return DUCKDUCKGO_WEB.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    return duckDuckGoHeaders({
      accept: stream ? "text/event-stream" : "application/json",
      cookieHeader: duckDuckGoWebCookieHeader(credentials),
    });
  }

  transformRequest(model, body, stream, credentials) {
    return buildDuckDuckGoWebPayload({
      model: model || DUCKDUCKGO_WEB.defaultModel,
      messages: toDuckDuckGoMessages(body?.messages),
      publicKey: publicKeyJwk(),
      conversationId: randomUUID(),
      messageId: randomUUID(),
    });
  }

  /**
   * The refusal worth making before a request is spent.
   *
   * An unknown or no-longer-free model is refused **by name** rather than sent: the service answers those with
   * a 400 or a 429, and each attempt costs the address's anonymous-chat quota. This reads the *live* catalog —
   * the one endpoint that is free of the challenge and of the quota — so a model that stopped being free fails
   * here with the reason rather than at the service.
   *
   * It fails **open**: a catalog that cannot be read is not a reason to refuse a turn, because that would be a
   * named error about this gateway rather than about the request.
   */
  async refuseUnsupported(model, body, signal, proxyOptions) {
    if (body?.tool_choice === "required") {
      return 'Duck.ai answers in prose and has no way to force a tool call. Send `tool_choice: "auto"` or omit it.';
    }

    let free = [];
    try {
      free = freeDuckDuckGoWebModels(await duckDuckGoCatalog({ signal, proxyOptions }));
    } catch {
      return undefined;
    }
    if (free.length === 0) return undefined;
    if (free.some((entry) => entry.id === model)) return undefined;

    const known = free.map((entry) => entry.id).join(", ");
    return `Duck.ai does not offer ${model} on its free tier. Duck.ai serves ${known} free. ${model} is not free on this account, and a request for it would be refused by the service.`;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions }) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        response: errorResponse("Missing or empty messages array", "invalid_request", 400, "INVALID_REQUEST"),
        url: DUCKDUCKGO_WEB.baseUrl,
        headers: {},
        transformedBody: body,
      };
    }

    const requestedModel = model || body?.model || DUCKDUCKGO_WEB.defaultModel;
    const cookieHeader = duckDuckGoWebCookieHeader(credentials);
    const headers = this.buildHeaders(credentials, stream);

    const refusal = await this.refuseUnsupported(requestedModel, body, signal, proxyOptions);
    if (refusal) {
      return {
        response: errorResponse(refusal, "invalid_request", 400, "NOT_SUPPORTED"),
        url: DUCKDUCKGO_WEB.baseUrl,
        headers,
        transformedBody: body,
      };
    }

    let transformedBody;
    try {
      transformedBody = this.transformRequest(requestedModel, body, stream, credentials);
      const { response, headers: sentHeaders } = await duckDuckGoTurn({
        payload: transformedBody,
        cookieHeader,
        signal,
        proxyOptions,
      });

      if (!response.body) {
        return {
          response: errorResponse("Duck.ai returned an empty response body", "upstream_error", 502, ERROR_CODES.unavailable),
          url: DUCKDUCKGO_WEB.baseUrl,
          headers: sentHeaders ?? headers,
          transformedBody,
        };
      }

      const cid = `chatcmpl-ddg-${randomUUID().slice(0, 12)}`;
      const created = Math.floor(Date.now() / 1000);

      const finalResponse = stream
        ? new Response(buildStreamingResponse(response.body, requestedModel, cid, created, signal), {
            status: 200,
            headers: { ...SSE_HEADERS_NO_BUFFER },
          })
        : await buildNonStreamingResponse(
            response.body,
            requestedModel,
            cid,
            created,
            toDuckDuckGoMessages(messages).map((m) => m.content).join("\n"),
            signal,
          );

      return { response: finalResponse, url: DUCKDUCKGO_WEB.baseUrl, headers: sentHeaders ?? headers, transformedBody };
    } catch (error) {
      // Never thrown out of `execute`: the gateway turns a thrown error into a crash report, and a refusal from
      // duck.ai is an answer, not a crash.
      const kind = error instanceof DuckDuckGoWebError ? error.kind : "unavailable";
      const publicMessage = PUBLIC_MESSAGES[kind] || PUBLIC_MESSAGES.unavailable;
      const detail = error?.message ? ` (${error.message})` : "";
      const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 502;
      log?.warn?.("DDG-WEB", `${kind}: ${error?.message || String(error)}`);
      return {
        response: errorResponse(`${publicMessage}${detail}`, "upstream_error", status, ERROR_CODES[kind]),
        url: DUCKDUCKGO_WEB.baseUrl,
        headers,
        transformedBody,
      };
    }
  }
}

export default DuckDuckGoWebExecutor;
