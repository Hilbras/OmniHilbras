import { DefaultExecutor } from "./default.js";
import { gzip } from "zlib";
import { dbg } from "../utils/debugLog.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { randomUUID } from "node:crypto";

/**
 * CodeBuddyExecutor — talks to https://copilot.tencent.com/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here — omnihilbras still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 *
 * The gateway's channel verification (code 11128) expects requests to look
 * like the official CodeBuddy CLI: gzip-compressed body + matching headers.
 * We mirror the CLI's exact header set and compress the JSON payload with
 * gzip, setting content-encoding accordingly.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
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

      // CodeBuddy gateway requires X-Request-ID (matches CLI behavior)
      if (!headers["X-Request-ID"]) {
        headers["X-Request-ID"] = randomUUID().replace(/-/g, "");
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

        // Retry logic
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

    // Tencent's content filter flags CLI agent system prompts ("You are Claude
    // Code, Anthropic's official CLI...") as prompt injection / sensitive content
    // and rejects the whole request. Detect agent system prompts (length catch-all
    // + identity-marker regex) and replace them with a neutral one, while leaving
    // legitimate user system prompts untouched. content may be a string or typed
    // blocks ([{type:"text",text}]) depending on the incoming client format, so
    // flatten before matching and preserve the original shape on replacement.
    const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
    const AGENT_PATTERN = /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;
    const flatten = (content) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
    if (Array.isArray(transformed.messages)) {
      transformed.messages = transformed.messages.map((message) => {
        if (!message || message.role !== "system") return message;
        const text = flatten(message.content);
        if (!text) return message;
        if (text.length > 2000 || AGENT_PATTERN.test(text)) {
          return typeof message.content === "string"
            ? { ...message, content: NEUTRAL_PROMPT }
            : { ...message, content: [{ type: "text", text: NEUTRAL_PROMPT }] };
        }
        return message;
      });
    }

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". omnihilbras's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).
    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        // 11128 "request illegal": the gateway's channel verification blocked the
        // request (spoofing detection / non-official-client heuristic). Not a
        // credential or quota problem — say so instead of a bare 400.
        if (data?.code === 11128) {
          return {
            status: 403,
            message: "CodeBuddy rejected the request at channel verification (11128) — the gateway thinks this call did not come from an official client. Try again, or re-authenticate the connection (the check is intermittent).",
          };
        }
        if (data?.code === 11102) {
          return {
            status: 400,
            message: "CodeBuddy: model service not found (11102) — the model is no longer published by the gateway.",
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

export default CodeBuddyExecutor;
