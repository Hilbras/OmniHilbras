import { DefaultExecutor } from "./default.js";
import { gzip } from "zlib";
import { dbg } from "../utils/debugLog.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { buildCodeBuddyConversationHeaders } from "../config/codebuddyConstants.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 *
 * The gateway's channel verification (code 11128) rejects any request that
 * does not carry the CLI's X-Conversation-* headers — see
 * config/codebuddyConstants.js. The body is also gzip-compressed like the
 * CLI does, though the gateway accepts plain JSON too.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};
    const retryConfig = { ...super.config?.retry };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model, transformedBody);
      if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

      // Channel verification (code 11128) requires the CLI's conversation
      // headers on every chat request — without them the gateway answers
      // HTTP 400 "request illegal".
      for (const [key, value] of Object.entries(buildCodeBuddyConversationHeaders())) {
        if (!headers[key]) headers[key] = value;
      }

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || 60000;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        // CodeBuddy gateway expects gzip-compressed bodies (matching the official CLI)
        const gzippedBody = await new Promise((resolve, reject) => {
          gzip(Buffer.from(bodyStr), (err, buf) => err ? reject(err) : resolve(buf));
        });
        const amendedHeaders = { ...headers, "content-encoding": "gzip", "content-length": String(gzippedBody.length) };
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${gzippedBody.length}B (gzip) | connectTimeout=${timeoutMs}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers: amendedHeaders,
          body: gzippedBody,
          signal: mergedSignal,
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        // Retry logic (copy from base)
        const retryKey = response.status;
        const retryEntry = retryConfig[retryKey] || retryConfig["default"] || { attempts: 0, delayMs: 5000 };
        if (retryEntry.attempts > 0 && retryAttemptsByUrl[urlIndex] < retryEntry.attempts) {
          retryAttemptsByUrl[urlIndex]++;
          log?.debug?.("RETRY", `status ${response.status} retry ${retryAttemptsByUrl[urlIndex]}/${retryEntry.attempts} after ${retryEntry.delayMs / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, retryEntry.delayMs));
          urlIndex--;
          continue;
        }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers: amendedHeaders, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        const retryKey = HTTP_STATUS.BAD_GATEWAY;
        const retryEntry = retryConfig[retryKey] || { attempts: 0, delayMs: 5000 };
        if (retryEntry.attempts > 0 && retryAttemptsByUrl[urlIndex] < retryEntry.attempts) {
          retryAttemptsByUrl[urlIndex]++;
          log?.debug?.("RETRY", `network "${error.message}" retry ${retryAttemptsByUrl[urlIndex]}/${retryEntry.attempts} after ${retryEntry.delayMs / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, retryEntry.delayMs));
          urlIndex--;
          continue;
        }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        // 11128 "request illegal": the gateway's channel verification blocked the
        // request. The gateway requires the CLI's X-Conversation-* headers on
        // every chat request — a request missing them lands here.
        if (data?.code === 11128) {
          return {
            status: 403,
            message: "CodeBuddy rejected the request at channel verification (11128) — the gateway requires the official CLI's conversation headers on every chat request. Re-authenticate the connection if this persists.",
          };
        }
        if (data?.code === 11102) {
          return {
            status: 400,
            message: `CodeBuddy: model service not found (11102) — the model is no longer published by the gateway.`,
          };
        }
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
