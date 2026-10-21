import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { browserFingerprintHeaders } from "../shared/webSession/common.js";
import {
  GEMINI_WEB,
  GEMINI_WEB_MODELS,
  buildGeminiWebPrompt,
  createGeminiWebDriver,
  geminiWebMessageText,
  normalizeGeminiWebCookie,
  parseGeminiWebCookieHeader,
  resolveGeminiWebModel,
} from "../shared/webSession/gemini-web.js";

/**
 * Gemini Web.
 *
 * Not an API integration: Google publishes no endpoint that accepts a browser
 * session, so the "upstream call" here is a page. The executor flattens the
 * request into one prompt, drives `gemini.google.com` in Chromium, and reads
 * the answer out of the `StreamGenerate` response the page makes for itself.
 *
 * The response it hands back is OpenAI-shaped — a chat-completions SSE stream
 * or a chat-completions JSON object — because the translator layer pivots
 * through OpenAI. The upstream parsing stays in here, so no translator has to
 * know what a `wrb.fr` envelope is.
 */

/** The page's own request headers, for the request log and for the fingerprint the page sends. */
function pageHeaders() {
  return browserFingerprintHeaders({
    origin: GEMINI_WEB.origin,
    referer: GEMINI_WEB.startUrl,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    // A document navigation, not an XHR — the composer is a page, and the page
    // makes its own `StreamGenerate` call.
    extra: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" },
  });
}

/**
 * The answer, as an OpenAI chat-completions SSE stream.
 *
 * The whole answer is emitted once, honestly: the page renders it, and there
 * are no tokens arriving over time. Splitting it into fake tokens would claim
 * a stream the provider does not have.
 */
function buildStreamingResponse(text, model, cid, created) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id: cid,
            object: "chat.completion.chunk",
            created,
            model,
            system_fingerprint: null,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id: cid,
            object: "chat.completion.chunk",
            created,
            model,
            system_fingerprint: null,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null, logprobs: null }],
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseChunk({
            id: cid,
            object: "chat.completion.chunk",
            created,
            model,
            system_fingerprint: null,
            choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
          }),
        ),
      );
      controller.enqueue(encoder.encode(SSE_DONE));
      controller.close();
    },
  });
}

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    // The registry entry owns the transport; the fallback keeps the executor
    // usable before the registry index is regenerated.
    super("gemini-web", PROVIDERS["gemini-web"] || { baseUrl: GEMINI_WEB.startUrl });
  }

  /**
   * The page.
   *
   * There is no upstream endpoint to call — the browser opens the app and the
   * app makes its own request — so this is the URL the request log shows.
   */
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return this.config?.baseUrl || GEMINI_WEB.startUrl;
  }

  /**
   * The browser's own headers.
   *
   * The credential is deliberately **not** here: it is injected into the
   * browser's cookie jar, because the page — not this process — makes the
   * request that carries it. A `Cookie` header would only end up in the
   * request log.
   */
  buildHeaders(credentials, stream = true) {
    return pageHeaders();
  }

  /**
   * The body is not transformed.
   *
   * The composer takes one turn, so the flattening into a prompt happens in
   * the driver, where the page is typed into — not here, where the body is
   * still the client's OpenAI request.
   */
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const url = this.buildUrl(model, stream, 0, credentials);
    const headers = this.buildHeaders(credentials, stream);

    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return this.errorResult(url, headers, body, 400, "Missing or empty messages array", "invalid_request_error", "INVALID_REQUEST");
    }

    // The pasted credential is the session cookie. `accessToken` is accepted
    // too, because that is where some connections keep it.
    const credential = credentials?.apiKey || credentials?.accessToken;
    if (!credential) {
      return this.errorResult(
        url,
        headers,
        body,
        401,
        "Paste a Gemini session cookie to use this provider.",
        "authentication_error",
        "AUTHENTICATION_FAILED",
      );
    }

    // The parser refuses a paste that is not a cookie — a request line, most
    // of all — and it says what to copy. That refusal is the answer, not an
    // exception: nothing is thrown out of `execute`.
    let cookie;
    try {
      cookie = normalizeGeminiWebCookie(credential);
    } catch (error) {
      return this.errorResult(
        url,
        headers,
        body,
        401,
        error?.message || "That is not a Gemini cookie.",
        "authentication_error",
        "AUTHENTICATION_FAILED",
      );
    }
    const pairs = parseGeminiWebCookieHeader(cookie);
    if (pairs.length === 0) {
      return this.errorResult(
        url,
        headers,
        body,
        401,
        "The pasted credential holds no usable Gemini cookie. Copy `__Secure-1PSID` (and `__Secure-1PSIDTS`) from gemini.google.com.",
        "authentication_error",
        "AUTHENTICATION_FAILED",
      );
    }

    // A forced tool choice cannot be honoured — tools here are emulated in the
    // prompt, and a caller that demanded a tool call would get prose — so it
    // is refused rather than silently downgraded.
    if (body?.tool_choice === "required") {
      return this.errorResult(
        url,
        headers,
        body,
        400,
        'Gemini Web drives the web UI, which has no way to force a tool call. Send `tool_choice: "auto"` or omit it.',
        "invalid_request_error",
        "NOT_SUPPORTED",
      );
    }

    // An unknown model cannot be selected in the UI, so it is refused rather
    // than answered by whichever mode the page happens to be in.
    const selected = resolveGeminiWebModel(model);
    if (!selected) {
      const known = GEMINI_WEB_MODELS.map((entry) => entry.id).join(", ");
      return this.errorResult(
        url,
        headers,
        body,
        400,
        `Gemini Web cannot select ${model}. The page offers ${known}.`,
        "invalid_request_error",
        "NOT_SUPPORTED",
      );
    }

    const turns = messages.map((message) => ({
      role: String(message?.role || "user"),
      text: geminiWebMessageText(message?.content),
    }));
    const prompt = buildGeminiWebPrompt(turns);
    if (!prompt.trim()) {
      return this.errorResult(
        url,
        headers,
        body,
        400,
        "Gemini Web needs a user message to type into the page.",
        "invalid_request_error",
        "INVALID_REQUEST",
      );
    }

    const driver = createGeminiWebDriver(credentials?.connectionId || "default");
    const available = await driver.available();
    if (!available.ok) {
      // Its own code, and not retryable: a missing browser will still be
      // missing on the next attempt, and retrying it would burn the failover
      // chain on an installation problem.
      log?.error?.("GEMINI-WEB", available.reason);
      return this.errorResult(url, headers, body, 503, available.reason, "provider_unavailable", "PROVIDER_UNAVAILABLE");
    }

    log?.info?.("GEMINI-WEB", `Driving ${model} (${selected.name}), prompt ${prompt.length} chars`);

    let answer;
    try {
      answer = await driver.ask({
        cookies: pairs,
        model: selected,
        messages: turns,
        timeoutMs: GEMINI_WEB.answerTimeoutMs + GEMINI_WEB.navigationTimeoutMs + GEMINI_WEB.settleMs,
        signal,
        onRotatedCookies: async (merged) => {
          await this.persistRotatedCookie(credentials, merged, log);
        },
      });
    } catch (error) {
      const status = error?.status || 502;
      const code = error?.code || "PROVIDER_REQUEST_FAILED";
      log?.error?.("GEMINI-WEB", `Turn failed: ${error?.message || String(error)}`);
      return this.errorResult(
        url,
        headers,
        body,
        status,
        error?.message || "The Gemini page could not be driven to an answer.",
        "upstream_error",
        code,
      );
    }

    const text = answer?.text ?? "";
    if (!text.trim()) {
      return this.errorResult(
        url,
        headers,
        body,
        502,
        "The Gemini page produced no answer. The session may have expired — check the cookie, then try again.",
        "upstream_error",
        "INVALID_RESPONSE",
      );
    }

    const cid = `chatcmpl-gemini-web-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      return {
        response: new Response(buildStreamingResponse(text, model, cid, created), {
          status: 200,
          headers: { ...SSE_HEADERS_NO_BUFFER },
        }),
        url,
        headers,
        transformedBody: body,
        // The executor answers in OpenAI's shape; the translator turns that into
        // whatever the client speaks.
        responseFormat: "openai",
      };
    }

    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(text.length / 4);
    return {
      response: new Response(
        JSON.stringify({
          id: cid,
          object: "chat.completion",
          created,
          model,
          system_fingerprint: null,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      url,
      headers,
      transformedBody: body,
      responseFormat: "openai",
    };
  }

  /**
   * An error, as the client sees it.
   *
   * Never thrown out of `execute`: the gateway turns a thrown error into a
   * generic 502, and these refusals are the difference between "copy fresher
   * cookies" and "Gemini is unavailable".
   */
  errorResult(url, headers, body, status, message, type, code) {
    return {
      response: new Response(JSON.stringify({ error: { message, type, code } }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      url,
      headers,
      transformedBody: body,
      responseFormat: "openai",
    };
  }

  /**
   * Stores the cookies Google rotated during the turn.
   *
   * Google replaces the `__Secure-1PSID*` cookies on its own schedule, and the
   * refreshed values have to be written back or the connection stops working
   * while its stored credential still parses. A failure here is swallowed: the
   * turn already produced an answer, and reporting it as failed would be a lie.
   */
  async persistRotatedCookie(credentials, merged, log) {
    if (!merged) return;
    // In-process first: the connection this request used holds the fresh cookie
    // from here on.
    if (credentials) credentials.apiKey = merged;
    const connectionId = credentials?.connectionId;
    if (!connectionId) return;
    try {
      // The same way the usage aggregator persists a refreshed session: the
      // engine reaches the local store only when it has something to write.
      const { updateProviderConnection } = await import("@/lib/localDb.js");
      await updateProviderConnection(connectionId, { apiKey: merged });
      log?.info?.("GEMINI-WEB", "Rotated Gemini cookies stored");
    } catch (error) {
      log?.warn?.("GEMINI-WEB", `Rotated Gemini cookies not stored: ${error?.message || String(error)}`);
    }
  }
}

export default GeminiWebExecutor;
