// ZCode Start Plan executor — free-tier GLM via the locally signed-in ZCode
// desktop client (verified live against ZCode 3.14.4, 2026-10).
//
// Wire notes (reverse-engineered, see registry/zcode.js):
//   - Anthropic Messages-shaped endpoint, but the stock ZCode request template
//     (system + 34-tool catalog, config/zcodeRequestTemplate.js) must be
//     preserved; replacing the system prompt is rejected (405 / code 3012).
//   - Auth: JWT sent as BOTH x-api-key and Authorization: Bearer.
//   - Thinking: thinking.type "enabled" + output_config.effort low|high|max
//     (applied centrally by thinkingUnified.applyFormat "zcode").
//   - The endpoint always streams real Anthropic SSE.
//   - Client tools: the gateway validates the stock 34-tool catalog, so a
//     client's own schemas are bridged through the conversation as a text
//     contract (see executors/zcode/toolBridge.js) and the model's JSON
//     answer is converted back into real Anthropic tool_use blocks. The
//     request template itself is never modified.
//
// Token resolution order (first hit wins):
//   1. connection apiKey — a pasted Start Plan JWT (enables multi-account
//      rotation exactly like every other provider's connections)
//   2. ZCODE_START_PLAN_TOKEN / ZCODE_JWT_TOKEN env
//   3. the local ZCode desktop credential store, decrypted with the
//      machine-derived key (see credentialSecret below — empirically verified:
//      the platform segment is bare process.platform, NOT "win32-x64")

import { createDecipheriv, createHash, randomUUID } from "crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, release, userInfo } from "node:os";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { ZCODE_REQUEST_TEMPLATE } from "../config/zcodeRequestTemplate.js";
import { TOOL_BRIDGE } from "../config/zcodeToolBridge.js";
import { ZCODE_ENVELOPE } from "../config/zcodeEnvelope.js";
import { ROLE, CLAUDE_BLOCK } from "../translator/schema/index.js";
import {
  buildToolContract,
  flattenToolBlocks,
  rewriteAnthropicMessage,
  rewriteAnthropicStream,
} from "./zcode/toolBridge.js";
import { parseZcodeEnvelope, zcodeBusinessCode } from "./zcode/envelope.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const APP_VERSION = "3.14.4";
const ORIGIN = "https://zcode.z.ai";
const MODEL_URL = `${ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`;
const BALANCE_URL = `${ORIGIN}/api/v1/zcode-plan/billing/balance`;

// Fingerprint headers, per the ZCode client's own source
// (packages/shared/src/zcode-source-headers.ts): X-Platform is
// `${platform}-${arch}`, X-Os-Category maps darwin → "macos", and the
// language/timezone headers carry the real client locale (printable ASCII
// only, "unknown" otherwise) — not a fixed capture's values.
const X_PLATFORM = `${process.platform}-${process.arch}`;
const X_OS_CATEGORY = process.platform === "win32" ? "windows"
  : process.platform === "darwin" ? "macos" : "linux";

function printableAscii(value) {
  const trimmed = value?.trim();
  return trimmed && /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

const CLIENT_LOCALE = (() => {
  try {
    return {
      language: printableAscii(Intl.DateTimeFormat().resolvedOptions().locale) ?? "unknown",
      timezone: printableAscii(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "unknown",
    };
  } catch {
    return { language: "unknown", timezone: "unknown" };
  }
})();

// ZCode Start Plan business codes, from the client's own classification
// (failure-provider-business-codes.ts + chatErrorAttributionEvidence.ts).
// The anthropic gateway can surface these on HTTP statuses the account
// rotation would otherwise ignore, so classify and coerce the status.
const ZCODE_BUSINESS_CODES = {
  // Terminal quota/credit: needs recharge or plan change → account-scoped billing error.
  1005: 402, 1314: 402, 1315: 402,
  // Terminal rate-limit windows (daily buckets / one-time grants) → rotate account.
  1316: 429, 1317: 429, 1318: 429, 1319: 429, 1320: 429, 1321: 429,
  // Retryable rate limits → backoff.
  3002: 429, 3008: 429, 3009: 429, 3010: 429,
  // Auth / model errors.
  3007: 401, 3006: 404,
};

export function classifyZcodeError(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const code = Number(parsed.code);
    const coerced = ZCODE_BUSINESS_CODES[code];
    if (coerced) {
      const label = coerced === 402 ? "quota exhausted"
        : coerced === 429 ? "rate limited"
        : coerced === 401 ? "authentication failed"
        : coerced === 404 ? "model not found" : "error";
      return {
        status: coerced,
        message: `ZCode ${label} (code ${code}): ${parsed.msg || parsed.message || ""}`.trim(),
      };
    }
    const detail = parsed.msg || parsed.message || bodyText;
    return { status, message: `${detail}${parsed.code !== undefined ? ` (code ${parsed.code})` : ""}` };
  } catch {
    return { status, message: bodyText || `HTTP ${status}` };
  }
}

/**
 * A ZCode business failure can ride on HTTP 200 as a bare JSON envelope, so
 * the body is inspected before it reaches the client. Without this an
 * exhausted account answers with an empty message — indistinguishable from a
 * broken tool bridge. Returns null when the body is a normal answer.
 */
function zcodeBusinessError(status, text) {
  const envelope = parseZcodeEnvelope(text);
  if (zcodeBusinessCode(envelope) === null) return null;
  const classified = classifyZcodeError(status, JSON.stringify(envelope));
  // An unmapped business code must still fail the turn — a 2xx status would
  // be reported to the client as a successful, empty answer.
  const errorStatus = classified.status >= 400 ? classified.status : 502;
  const error = new Error(`ZCode API error ${errorStatus}: ${classified.message.slice(0, 200)}`);
  error.status = errorStatus;
  return error;
}

/**
 * Inspect an upstream body for a business failure without giving up the
 * stream: the leading chunks are buffered, checked, and replayed downstream
 * when the turn is healthy.
 */
async function inspectUpstreamBody(response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const isSse = contentType.includes("text/event-stream");

  if (!isSse) {
    const text = await response.text();
    const error = zcodeBusinessError(response.status, text);
    if (error) return { error, response };
    return {
      error: null,
      response: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }

  if (!response.body) return { error: null, response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  while (text.length < ZCODE_ENVELOPE.peekLimitBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    text += decoder.decode(value, { stream: true });
    if (parseZcodeEnvelope(text)) break;
  }

  const error = zcodeBusinessError(response.status, text);
  if (error) return { error, response };

  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      })();
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });

  return {
    error: null,
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

const MODEL_MAP = {
  "glm-5.3-flash": "GLM-5.3-Flash",
  "zcode-glm-5.3-flash": "GLM-5.3-Flash",
  "glm-5.3": "GLM-5.3",
};
const MAX_TOKENS_CEILING = ZCODE_REQUEST_TEMPLATE.max_tokens || 128000;

function credentialSecret() {
  const explicit = process.env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (explicit) return explicit;
  // os.userInfo().username is the client's own source of the machine username
  // (credentialCipherProvider.ts) — env vars can lie about it.
  let username = "unknown";
  try { username = userInfo().username || username; } catch { /* keep fallback */ }
  return `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`;
}

function credentialsPath() {
  return process.env.ZCODE_CREDENTIALS_FILE?.trim() || join(homedir(), ".zcode", "v2", "credentials.json");
}

function decryptCredential(value) {
  if (!value || !value.startsWith("enc:v1:")) return value;
  const parts = value.slice(7).split(".");
  if (parts.length !== 3) throw new Error("Invalid ZCode credential format");
  const iv = Buffer.from(parts[0], "base64url");
  const tag = Buffer.from(parts[1], "base64url");
  const ciphertext = Buffer.from(parts[2], "base64url");
  const key = createHash("sha256").update(credentialSecret()).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Cache the decrypted local token with the store's mtime: the desktop client
// can rotate the JWT under us, and a 401 clears this cache for one re-read.
const localAuthCache = { token: null, accountUuid: null, mtimeMs: 0 };

function readLocalAuth() {
  const path = credentialsPath();
  if (!existsSync(path)) {
    throw new Error(`ZCode credentials not found at ${path}. Install and sign into the ZCode desktop client, or set ZCODE_START_PLAN_TOKEN.`);
  }
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { /* best-effort freshness key */ }
  if (localAuthCache.token && localAuthCache.mtimeMs === mtimeMs) return localAuthCache;

  const store = JSON.parse(readFileSync(path, "utf8"));
  const raw = store.zcodejwttoken;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("No ZCode Start Plan token (zcodejwttoken) in the local credential store.");
  }
  const auth = { token: decryptCredential(raw).trim(), accountUuid: "", mtimeMs };
  try {
    const profile = JSON.parse(decryptCredential(store["oauth:zai:user_info"]));
    if (typeof profile.user_id === "string") auth.accountUuid = profile.user_id.trim();
  } catch { /* account uuid is optional metadata */ }
  localAuthCache.token = auth.token;
  localAuthCache.accountUuid = auth.accountUuid;
  localAuthCache.mtimeMs = mtimeMs;
  return auth;
}

function invalidateLocalAuthCache() {
  localAuthCache.token = null;
  localAuthCache.accountUuid = null;
  localAuthCache.mtimeMs = 0;
}

function loadDeviceMid() {
  const explicit = process.env.ZCODE_DEVICE_MID?.trim();
  if (explicit) return explicit;
  try {
    const data = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "telemetry-state.json"), "utf8"));
    return typeof data.deviceMid === "string" ? data.deviceMid.trim() : "";
  } catch {
    return "";
  }
}

function resolveToken(credentials) {
  const pasted = typeof credentials?.apiKey === "string" ? credentials.apiKey.trim() : "";
  if (pasted) return { token: pasted, accountUuid: "", source: "connection" };
  const envToken = (process.env.ZCODE_START_PLAN_TOKEN || process.env.ZCODE_JWT_TOKEN || "").trim();
  if (envToken) return { token: envToken, accountUuid: "", source: "env" };
  const auth = readLocalAuth();
  return { token: auth.token, accountUuid: auth.accountUuid, source: "local" };
}

// RFC 9562 UUIDv7 (epoch-ms + random) — the client sends this shape as x-query-id.
function uuid7Like() {
  const ms = BigInt(Date.now()) & 0xFFFFFFFFFFFFn;
  const rand = BigInt(`0x${randomUUID().replaceAll("-", "").slice(16)}`);
  const value = (ms << 80n) | (0x7n << 76n) | ((rand >> 64n) & 0x0FFFn) | (0b10n << 62n) | (rand & 0x3FFFFFFFFFFFFFFFn);
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function baseHeaders(token) {
  const headers = {
    "User-Agent": `ZCode/${APP_VERSION}`,
    "HTTP-Referer": ORIGIN,
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": APP_VERSION,
    "X-Platform": X_PLATFORM,
    "X-Release-Channel": "production",
    "X-Client-Language": CLIENT_LOCALE.language,
    "X-Client-Timezone": CLIENT_LOCALE.timezone,
    "X-Os-Category": X_OS_CATEGORY,
    "X-Os-Version": release(),
    "X-ZCode-Agent": "glm",
    "Accept": "application/json",
    "x-request-id": randomUUID(),
    "Authorization": `Bearer ${token}`,
  };
  const deviceMid = loadDeviceMid();
  if (deviceMid) headers["X-Device-Mid"] = deviceMid;
  return headers;
}

function modelHeaders(token, sessionId) {
  return {
    ...baseHeaders(token),
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": `ZCode/${APP_VERSION} ai-sdk/anthropic/3.0.81`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "mid-conversation-system-2026-04-07",
    "x-api-key": token,
    "x-zcode-trace-id": randomUUID(),
    "x-zcode-session-type": "main",
    "x-query-id": uuid7Like(),
    "x-session-id": sessionId,
  };
}

// Deep-clone the stock template and fill the one runtime placeholder.
function buildTemplateBody() {
  const body = JSON.parse(JSON.stringify(ZCODE_REQUEST_TEMPLATE));
  const workspace = join(homedir(), ".zcode", "workspace", "default");
  const walk = (value) => {
    if (typeof value === "string") return value.replaceAll("__ZCODE_PRIMARY_WORKING_DIRECTORY__", workspace);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(body);
}

function backendModelId(model) {
  return MODEL_MAP[String(model || "").trim().toLowerCase()] || "GLM-5.3-Flash";
}

// The upstream system prompt must stay stock, so a client system (already
// translated to Claude `system` by the framework) rides along as a marked text
// block on the first user turn instead of replacing it.
function clientTools(body) {
  return Array.isArray(body?.tools) ? body.tools : [];
}

function systemTextOf(body) {
  return typeof body.system === "string" ? body.system.trim()
    : Array.isArray(body.system)
      ? body.system.map(b => (typeof b === "string" ? b : b?.text) || "").join("\n").trim()
      : "";
}

function textBlock(text) {
  return { type: CLAUDE_BLOCK.TEXT, text };
}

// Prepend a marked block to a user turn (block content keeps its own blocks).
function withLeadingBlock(message, text) {
  if (Array.isArray(message.content)) {
    return { ...message, content: [textBlock(text), ...message.content] };
  }
  if (typeof message.content === "string") {
    return { ...message, content: [textBlock(`${text}\n\n${message.content}`)] };
  }
  return { ...message, content: [textBlock(text)] };
}

// Append the tool contract at the tail of a user turn — the model reads it
// last, right before it answers.
function withTrailingText(message, text) {
  if (Array.isArray(message.content)) {
    return { ...message, content: [...message.content, textBlock(text)] };
  }
  if (typeof message.content === "string") {
    return { ...message, content: [textBlock(`${message.content}\n\n${text}`)] };
  }
  return { ...message, content: [textBlock(text)] };
}

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === ROLE.USER) return i;
  }
  return -1;
}

function mapMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemText = systemTextOf(body);
  const tools = clientTools(body);

  // Without client tools the request stays byte-identical to the plain path.
  if (!tools.length) {
    if (!systemText) return messages;
    const preamble = `[SESSION INSTRUCTIONS — the operational contract for this conversation]\n${systemText}`;
    const first = messages[0];
    if (first && first.role === ROLE.USER) {
      return [withLeadingBlock(first, preamble), ...messages.slice(1)];
    }
    return [{ role: ROLE.USER, content: [textBlock(preamble)] }, ...messages];
  }

  // Client-tool path: the stock catalog cannot resolve the client's tool ids,
  // so earlier tool_use / tool_result turns are replayed as marked plain text.
  const turns = flattenToolBlocks(messages);

  if (systemText) {
    const preamble = `[SESSION INSTRUCTIONS — the operational contract for this conversation]\n${systemText}`;
    const firstUser = turns.findIndex((turn) => turn.role === ROLE.USER);
    if (firstUser === -1) {
      turns.unshift({ role: ROLE.USER, content: [textBlock(preamble)] });
    } else {
      turns[firstUser] = withLeadingBlock(turns[firstUser], preamble);
    }
  }

  const contract = buildToolContract(tools);
  const closing = `${contract}\n\n${TOOL_BRIDGE.responseInstruction}`;
  const target = lastUserIndex(turns);
  if (target === -1) {
    turns.push({ role: ROLE.USER, content: [textBlock(closing)] });
  } else {
    turns[target] = withTrailingText(turns[target], closing);
  }
  return turns;
}

function buildRequestBody(body, model, sessionId, accountUuid, stream = true) {
  const template = buildTemplateBody();
  template.model = backendModelId(model);
  // The endpoint serves both modes natively (verified live): SSE when the
  // client streams, a single Anthropic JSON message otherwise — which keeps
  // the framework's standard claude-format non-stream translation working.
  template.stream = stream !== false;
  template.messages = mapMessages(body);
  template.metadata = {
    user_id: JSON.stringify({ device_id: loadDeviceMid(), account_uuid: accountUuid, session_id: sessionId }),
  };
  // thinking/output_config are written by applyThinking ("zcode" format);
  // keep the template default (enabled/max) when the client sent nothing.
  if (body.thinking && typeof body.thinking === "object") template.thinking = body.thinking;
  if (body.output_config && typeof body.output_config === "object") template.output_config = body.output_config;
  const clientMax = Number(body.max_tokens);
  template.max_tokens = Number.isFinite(clientMax) && clientMax > 0
    ? Math.min(clientMax, MAX_TOKENS_CEILING)
    : MAX_TOKENS_CEILING;
  // Client tool schemas are bridged through the conversation (mapMessages), not
  // through template.tools: upstream validates the stock ZCode tool catalog, so
  // anything else here is rejected. The template catalog stays untouched.
  return template;
}

// Rewrite an upstream answer into the client's view: the stock catalog's own
// tool_use blocks are dropped, and a bridge JSON answer becomes real tool_use
// blocks the client can resolve. The upstream body is buffered — the text
// cannot be classified as text or tool call before the turn ends.
async function bridgeUpstreamResponse(response, tools, stream, log) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const isSse = contentType.includes("text/event-stream")
    || (!contentType && stream !== false);
  const text = await response.text();
  // A business failure can ride on HTTP 200 as a bare JSON envelope — it must
  // fail the turn here, not become an empty "successful" answer.
  const businessError = zcodeBusinessError(response.status, text);
  if (businessError) throw businessError;
  const headers = {
    "content-type": isSse ? "text/event-stream" : "application/json",
  };
  try {
    if (isSse) {
      return new Response(rewriteAnthropicStream(text, tools), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const parsed = JSON.parse(text);
    return new Response(JSON.stringify(rewriteAnthropicMessage(parsed, tools)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    // A malformed upstream body must not break the turn — pass it through.
    log?.warn?.("ZCODE", `Tool bridge rewrite failed: ${error.message}`);
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export class ZCodeExecutor extends BaseExecutor {
  constructor() {
    super("zcode", PROVIDERS.zcode);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    let auth;
    try {
      auth = resolveToken(credentials);
    } catch (error) {
      log?.error?.("ZCODE", `Credential error: ${error.message}`);
      throw new Error(`ZCode auth failed: ${error.message}`);
    }

    const sessionId = randomUUID();
    const requestBody = buildRequestBody(body, model, sessionId, auth.accountUuid, stream);
    const headers = modelHeaders(auth.token, sessionId);
    log?.debug?.("ZCODE", `→ ${MODEL_URL} | model=${requestBody.model} effort=${requestBody.output_config?.effort} tokens=${requestBody.max_tokens} stream=${requestBody.stream} auth=${auth.source}`);

    const dispatch = (token) => {
      const requestHeaders = modelHeaders(token, sessionId);
      if (!requestBody.stream) requestHeaders.Accept = "application/json";
      return proxyAwareFetch(MODEL_URL, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal,
      }, proxyOptions);
    };

    let response = await dispatch(auth.token);

    // Desktop client may have rotated the local JWT under us — re-read once.
    if ((response.status === 401 || response.status === 403) && auth.source === "local") {
      invalidateLocalAuthCache();
      try {
        auth = resolveToken(credentials);
        response = await dispatch(auth.token);
      } catch (error) {
        log?.warn?.("ZCODE", `Token re-read after ${response.status} failed: ${error.message}`);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      log?.error?.("ZCODE", `Response ${response.status}: ${text.slice(0, 300)}`);
      // Classify ZCode business codes (quota/rate-limit can ride on unexpected
      // HTTP statuses) so account rotation and backoff see the right status.
      const classified = classifyZcodeError(response.status, text.slice(0, 400));
      const error = new Error(`ZCode API error ${classified.status}: ${classified.message.slice(0, 200)}`);
      error.status = classified.status;
      throw error;
    }

    const tools = clientTools(body);
    if (tools.length) {
      const bridged = await bridgeUpstreamResponse(response, tools, stream, log);
      return { response: bridged, url: MODEL_URL, headers: bridged.headers, transformedBody: requestBody };
    }

    // No client tools: the body is still inspected, because a business failure
    // can ride on HTTP 200 as a bare JSON envelope.
    const inspected = await inspectUpstreamBody(response);
    if (inspected.error) throw inspected.error;
    return {
      response: inspected.response,
      url: MODEL_URL,
      headers: inspected.response.headers,
      transformedBody: requestBody,
    };
  }

  buildUrl() {
    return MODEL_URL;
  }

  buildHeaders() {
    return { "Content-Type": "application/json" };
  }

  parseError(response, bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      const code = parsed.code !== undefined ? ` (code ${parsed.code})` : "";
      return { status: response.status, message: `${parsed.msg || parsed.message || bodyText}${code}` };
    } catch {
      return { status: response.status, message: bodyText || `HTTP ${response.status}` };
    }
  }
}

// Live quota buckets — read-only GET, used by connection validation and usage.
export async function fetchZcodeBalance(credentials, { signal, proxyOptions } = {}) {
  const auth = resolveToken(credentials);
  const response = await proxyAwareFetch(`${BALANCE_URL}?app_version=${APP_VERSION}`, {
    headers: baseHeaders(auth.token),
    signal,
  }, proxyOptions);
  const body = await response.json().catch(() => null);
  if (!response.ok || (body && body.code !== undefined && body.code !== 0 && body.code !== "0")) {
    const detail = body?.msg || body?.message || `HTTP ${response.status}`;
    throw new Error(`ZCode balance check failed: ${detail}`);
  }
  return body;
}

// Internal helpers exported for tests.
export {
  backendModelId,
  buildRequestBody,
  clientTools,
  credentialSecret,
  decryptCredential,
  invalidateLocalAuthCache,
  mapMessages,
  modelHeaders,
  resolveToken,
};

export default ZCodeExecutor;
