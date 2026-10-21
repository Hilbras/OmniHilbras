import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { browserFingerprintHeaders, profileDir, readBodyRefusal } from "../shared/webSession/common.js";
import registryEntry from "../providers/registry/chatgpt-web.js";
import {
  CHATGPT_WEB,
  ChatGptWebError,
  chatGptWebSessionFromCredential,
  chatGptWebDirectModel,
  openChatGptPage,
  resolveChatGptWebSelection,
} from "../shared/webSession/chatgpt-web.js";

/**
 * ChatGPT Web — a turn driven through chatgpt.com itself.
 *
 * There is no OpenAI endpoint that accepts a browser session, so the turn is
 * made from inside the page: ChatGPT's own request module mints the Sentinel
 * requirements, the proof-of-work and Turnstile tokens, and posts
 * `/f/conversation`. Everything this file does around that is the plumbing —
 * the payload the page is given, the answer read back out of the response
 * stream, and the OpenAI-shaped body the gateway hands back.
 */

/**
 * The transport, read from the registry entry.
 *
 * The registry index is generated, so the entry itself is the source of truth
 * and the built map is only a convenience — reading the entry keeps this
 * executor working before the index is regenerated.
 */
const CHATGPT_WEB_TRANSPORT = PROVIDERS["chatgpt-web"] || registryEntry.transport;
const CHATGPT_WEB_BASE_URL = CHATGPT_WEB_TRANSPORT.baseUrl || CHATGPT_WEB.origin;

/**
 * Only a first-party chunk is ever read.
 *
 * The asset list comes off a live page, so it is treated as untrusted input:
 * an origin or a path outside `/cdn/assets/*.js` is refused before anything
 * is fetched from it.
 */
const CHATGPT_ASSET_PATH_RE = /^\/cdn\/assets\/[A-Za-z0-9_-]+\.js$/;
const BRIDGE_KEY = "__omnihilbrasChatGptFirstPartyV1";
const REQUEST_KEY = "__omnihilbrasChatGptRequestV1";
const ABORT_KEY = "__omnihilbrasChatGptAbortV1";

const MAX_DISCOVERY_ASSETS = 256;
const MODULE_DISCOVERY_TIMEOUT_MS = 30_000;
const MODULE_DISCOVERY_POLL_MS = 300;
const ASSET_FETCH_TIMEOUT_MS = 20_000;
const MAX_ASSET_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_CONVERSATION_RESPONSE_BYTES = 16 * 1024 * 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The minified export name for a local binding.
 *
 * Read from the trailing `export{…}` block rather than from a pinned string,
 * because the short name on the left of an export changes on every build and
 * the semantic marker does not.
 */
function exportedName(source, localName) {
  const exportStart = source.lastIndexOf("export{");
  if (exportStart < 0) return null;
  const block = source.slice(exportStart + "export{".length);
  const match = block.match(new RegExp(`(?:^|,)${escapeRegExp(localName)} as ([A-Za-z_$][\\w$]*)`));
  return match?.[1] ?? null;
}

/**
 * Finds the five things a turn needs, by what they do.
 *
 * These are semantic markers in the minified source, deliberately not pinned
 * identifiers. They are the fragile part of this whole approach and the
 * reason a failure names itself.
 */
export function parseFirstPartyContract(source) {
  const finalizeLocal = source.match(
    /function ([A-Za-z_$][\w$]*)\(e=!1,t=`none`(?:,n=[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)?\)\{return [A-Za-z_$][\w$]*\(`finalized`,e,t(?:,n)?\)\}/,
  )?.[1];
  const enforcement = source.match(
    /Promise\.all\(\[([A-Za-z_$][\w$]*)\.getEnforcementToken\(t,\{forceSync:!0\}\),([A-Za-z_$][\w$]*)\.getEnforcementToken\(t\)\]\)/,
  );
  const requestClientLocal = source.match(/([A-Za-z_$][\w$]*)\.safePost\(`\/sentinel\/chat-requirements\/prepare`/)?.[1];
  const headerBuilderLocal = source.match(
    /function ([A-Za-z_$][\w$]*)\(e,t,n,r,i,a\)\{let o=\{\};return e\?\.token\?o\[`OpenAI-Sentinel-Chat-Requirements-Token`\]/,
  )?.[1];
  const proofLocal = enforcement?.[1];
  const turnstileLocal = enforcement?.[2];
  if (!finalizeLocal || !proofLocal || !turnstileLocal || !requestClientLocal || !headerBuilderLocal) {
    throw new ChatGptWebError(
      "PROVIDER_REQUEST_FAILED",
      "ChatGPT changed its request module: none of the required markers were found in any asset.",
    );
  }
  const found = {
    finalizeRequirements: exportedName(source, finalizeLocal),
    proofManager: exportedName(source, proofLocal),
    turnstileManager: exportedName(source, turnstileLocal),
    requestClient: exportedName(source, requestClientLocal),
    buildSentinelHeaders: exportedName(source, headerBuilderLocal),
  };
  if (Object.values(found).some((value) => value === null)) {
    throw new ChatGptWebError(
      "PROVIDER_REQUEST_FAILED",
      "ChatGPT changed its request module: the markers were found but their exports were not.",
    );
  }
  return found;
}

/**
 * Refuses a ChatGPT asset from outside the first-party origin.
 *
 * The asset list comes off a live page, so it is untrusted input.
 */
export function requireChatGptAssetUrl(value) {
  const url = new URL(value);
  if (url.origin !== CHATGPT_WEB.origin || !CHATGPT_ASSET_PATH_RE.test(url.pathname)) {
    throw new Error("Refusing to load a ChatGPT asset from outside the first-party origin.");
  }
  return url.toString();
}

export function collectAssetCandidates(resourceUrls, modulePreloadUrls) {
  return Array.from(new Set([...resourceUrls, ...modulePreloadUrls])).filter(
    (url) => url.includes("/cdn/assets/") && url.endsWith(".js"),
  );
}

/** Chunks referenced relatively by a chunk already inspected. */
export function extractAssetReferences(source, parentAssetUrl) {
  const references = [];
  const seen = new Set();
  for (const match of source.matchAll(/["']\.\/([A-Za-z0-9_-]+\.js)["']/g)) {
    let assetUrl;
    try {
      assetUrl = requireChatGptAssetUrl(new URL(`./${match[1]}`, parentAssetUrl).toString());
    } catch {
      continue;
    }
    if (!seen.has(assetUrl)) {
      seen.add(assetUrl);
      references.push(assetUrl);
    }
  }
  return references;
}

async function readAssetSource(url, proxyOptions) {
  const response = await proxyAwareFetch(
    url,
    { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) },
    proxyOptions ?? null,
  );
  if (!response.ok) throw new Error(`ChatGPT asset could not be loaded (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ASSET_SOURCE_BYTES) {
    throw new Error("ChatGPT asset exceeded the size limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_SOURCE_BYTES) throw new Error("ChatGPT asset exceeded the size limit");
  return new TextDecoder().decode(bytes);
}

const contracts = new Map();
let lastKnownAssetUrl = null;

async function pageCandidates(page) {
  const sources = await page.evaluate(() => ({
    preloads: Array.from(document.querySelectorAll('link[rel="modulepreload"][href]'), (link) => link.href),
    resources: performance.getEntriesByType("resource").map((entry) => entry.name),
  }));
  return collectAssetCandidates(sources.resources, sources.preloads);
}

/**
 * Scans the page's own assets for the request module.
 *
 * The page loads chunks lazily, so the candidate list is re-read on a poll
 * rather than taken once: the module a turn needs is often not in the first
 * list.
 */
export async function discoverFirstPartyModule(page, proxyOptions) {
  const queue = lastKnownAssetUrl ? [lastKnownAssetUrl] : [];
  const visited = new Set();
  let index = 0;
  let lastError = null;
  const deadline = Date.now() + MODULE_DISCOVERY_TIMEOUT_MS;

  while (Date.now() <= deadline && visited.size < MAX_DISCOVERY_ASSETS) {
    if (index >= queue.length) {
      try {
        queue.push(...(await pageCandidates(page)).filter((candidate) => !visited.has(candidate)));
      } catch {
        // A page that has not finished loading simply has no candidates yet.
      }
      if (index >= queue.length) {
        await page.waitForTimeout(MODULE_DISCOVERY_POLL_MS);
        continue;
      }
    }
    const candidate = queue[index];
    index += 1;
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);

    let assetUrl;
    try {
      assetUrl = requireChatGptAssetUrl(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Invalid ChatGPT asset URL");
      continue;
    }
    try {
      const cached = contracts.get(assetUrl);
      const contract = cached
        ? await cached
        : await (async () => {
            const source = await readAssetSource(assetUrl, proxyOptions);
            const parsed = parseFirstPartyContract(source);
            // Anything the module references is worth inspecting too, since
            // the contract is sometimes split across two chunks.
            queue.push(...extractAssetReferences(source, assetUrl).filter((ref) => !visited.has(ref)));
            return parsed;
          })();
      contracts.set(assetUrl, Promise.resolve(contract));
      lastKnownAssetUrl = assetUrl;
      return { assetUrl, contract };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("ChatGPT module discovery failed");
    }
  }
  throw new ChatGptWebError(
    "PROVIDER_REQUEST_FAILED",
    `ChatGPT's request module was not found in ${visited.size} asset(s)${lastError ? `: ${lastError.message}` : ""}`,
  );
}

/**
 * Hands ChatGPT's own exports to the rest of this module.
 *
 * The asset is imported **directly** rather than through a generated blob
 * module that re-exports from it. The blob indirection is one more thing
 * that can fail for reasons that have nothing to do with the answer: a blob
 * module importing a cross-origin asset fails with a bare "Failed to fetch
 * dynamically imported module" that says nothing about the cause, while
 * importing the asset itself works and hands over 4000-odd exports. So the
 * five functions are lifted out of the module namespace directly.
 *
 * The names are looked up rather than destructured, so a missing one is named
 * here instead of failing as `undefined is not a function` three calls later.
 */
async function ensureBridge(page, proxyOptions) {
  const ready = await page.evaluate((key) => {
    const value = globalThis[key];
    return typeof value === "object" && value !== null;
  }, BRIDGE_KEY);
  if (ready) return;

  const { assetUrl, contract } = await discoverFirstPartyModule(page, proxyOptions);
  const installed = await page.evaluate(
    async (args) => {
      const { bridgeKey, url, names } = args;
      const root = globalThis;
      if (typeof root[bridgeKey] === "object" && root[bridgeKey] !== null) return true;
      let chatGptModule;
      try {
        chatGptModule = await import(/* @vite-ignore */ url);
      } catch (error) {
        throw new Error(
          `ChatGPT's request module could not be imported: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
        );
      }
      const missing = Object.entries(names)
        .filter(([, exportName]) => typeof chatGptModule[exportName] === "undefined")
        .map(([role]) => role);
      if (missing.length > 0) {
        throw new Error(`ChatGPT's request module does not export ${missing.join(", ")}; its build has changed.`);
      }
      root[bridgeKey] = {
        finalizeRequirements: chatGptModule[names.finalizeRequirements],
        proofManager: chatGptModule[names.proofManager],
        turnstileManager: chatGptModule[names.turnstileManager],
        requestClient: chatGptModule[names.requestClient],
        buildSentinelHeaders: chatGptModule[names.buildSentinelHeaders],
      };
      return true;
    },
    { bridgeKey: BRIDGE_KEY, url: assetUrl, names: contract },
  );
  if (!installed) throw new ChatGptWebError("PROVIDER_REQUEST_FAILED", "The ChatGPT request module did not install.");
}

/* ------------------------------------------------------------------ *
 * One turn
 * ------------------------------------------------------------------ */

/**
 * The conversation body, exactly as the page would build it for itself.
 *
 * Thinking is asked for with a system hint, not by naming a different model,
 * and Pro never carries the hint — see `chatGptWebDirectModel`.
 */
export function buildConversationBody({
  prompt,
  model,
  reason,
  messageId,
  createTime,
  timezoneOffset = 0,
  timezone = "UTC",
}) {
  return {
    action: "next",
    messages: [
      {
        id: messageId,
        author: { role: "user" },
        create_time: createTime,
        content: { content_type: "text", parts: [prompt] },
        metadata: {
          ...(reason ? { system_hints: ["reason"] } : {}),
          serialization_metadata: { custom_symbol_offsets: [] },
        },
      },
    ],
    parent_message_id: "client-created-root",
    model,
    timezone_offset_min: timezoneOffset,
    timezone,
    history_and_training_disabled: true,
    conversation_mode: { kind: "primary_assistant" },
    system_hints: reason ? ["reason"] : [],
    supports_buffering: true,
    supported_encodings: ["v1"],
  };
}

/**
 * Makes one turn and returns the raw SSE body.
 *
 * Every step runs inside the page, because every step is ChatGPT's own code:
 * its Sentinel requirements, its proof-of-work and Turnstile tokens, its
 * request client. The alternative — driving the composer — posts a request
 * the page never completes, which is what this replaced.
 */
export async function executeFirstPartyTurn(page, turn, proxyOptions) {
  await ensureBridge(page, proxyOptions);
  const requestId = globalThis.crypto.randomUUID();

  // The page's own clock and timezone, because the body is the page's.
  const pageEnv = await page.evaluate(() => ({
    createTime: Date.now() / 1000,
    timezoneOffset: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));

  const conversationBody = buildConversationBody({
    prompt: turn.prompt,
    model: turn.model,
    reason: turn.reason,
    messageId: globalThis.crypto.randomUUID(),
    createTime: pageEnv.createTime,
    timezoneOffset: pageEnv.timezoneOffset,
    timezone: pageEnv.timezone,
  });

  // 1. The conversation body, parked where the page's own code can find it.
  await page.evaluate(
    (args) => {
      const { requestKey, abortKey, id, body } = args;
      const root = globalThis;
      const requests = (root[requestKey] ??= {});
      const aborts = (root[abortKey] ??= {});
      aborts[id] = new AbortController();
      requests[id] = { body };
    },
    { requestKey: REQUEST_KEY, abortKey: ABORT_KEY, id: requestId, body: conversationBody },
  );

  try {
    // 2. The anti-automation artifacts, minted by ChatGPT's own managers.
    await page.evaluate(
      async (args) => {
        const { bridgeKey, requestKey, abortKey, id } = args;
        const root = globalThis;
        const bridge = root[bridgeKey];
        const draft = root[requestKey][id];
        const controller = root[abortKey][id];
        const requirements = await bridge.finalizeRequirements(false, "none");
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const [proof, turnstile] = await Promise.all([
          bridge.proofManager.getEnforcementToken(requirements, { forceSync: true }),
          bridge.turnstileManager.getEnforcementToken(requirements),
        ]);
        draft.additionalHeaders = bridge.buildSentinelHeaders(requirements, turnstile, proof, null, null, null);
      },
      { bridgeKey: BRIDGE_KEY, requestKey: REQUEST_KEY, abortKey: ABORT_KEY, id: requestId },
    );

    // 3. The conversation, and the whole of the answer.
    return await page.evaluate(
      async (args) => {
        const { bridgeKey, requestKey, abortKey, id, limit } = args;
        const root = globalThis;
        const client = root[bridgeKey].requestClient;
        const draft = root[requestKey][id];
        const controller = root[abortKey][id];
        const response = await client.safePost("/f/conversation", {
          requestBody: draft.body,
          additionalHeaders: draft.additionalHeaders,
          signal: controller.signal,
          skipJsonTransform: true,
        });
        if (!(response instanceof Response)) throw new Error("The conversation request returned a non-response.");
        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`The conversation request failed with status ${status}.`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("The conversation response was an empty stream.");
        const decoder = new TextDecoder();
        const chunks = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > limit) {
              await reader.cancel().catch(() => undefined);
              throw new Error("The conversation response exceeded the size limit.");
            }
            chunks.push(decoder.decode(value, { stream: true }));
          }
          chunks.push(decoder.decode());
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Already released after a cancellation.
          }
        }
        return chunks.join("");
      },
      {
        bridgeKey: BRIDGE_KEY,
        requestKey: REQUEST_KEY,
        abortKey: ABORT_KEY,
        id: requestId,
        limit: MAX_CONVERSATION_RESPONSE_BYTES,
      },
    );
  } finally {
    await page
      .evaluate(
        (args) => {
          const { requestKey, abortKey, id } = args;
          const root = globalThis;
          delete root[requestKey]?.[id];
          delete root[abortKey]?.[id];
        },
        { requestKey: REQUEST_KEY, abortKey: ABORT_KEY, id: requestId },
      )
      .catch(() => undefined);
  }
}

/**
 * Pulls the assistant's text out of the conversation SSE body.
 *
 * The body is a JSON-patch stream over the conversation document, so the
 * patches are applied to a tree and the last assistant turn is read from the
 * result. Reading the last delta instead would truncate mid-sentence
 * whenever the stream is cut.
 */
export function extractAssistantText(sseBody) {
  /**
   * The stream is JSON Patch, as objects: `{ p, o, v }`.
   *
   * Three shapes matter, and getting any of them wrong reads as an answer
   * that never came:
   *
   * - `{ v: { message: … } }` with no path — a whole message, appended to the
   *   transcript.
   * - `{ p: "/message/content/parts/0", o: "append", v: "working" }` —
   *   **append**, which for a string means concatenate, not replace. Treating
   *   it as a replace keeps only the final fragment.
   * - `{ p: "", o: "patch", v: [ …ops ] }` — a batch of the same operations.
   */
  const turns = [];

  const applyOperation = (operation) => {
    if (typeof operation !== "object" || operation === null) return;
    const path = typeof operation.p === "string" ? operation.p : "";
    const kind = typeof operation.o === "string" ? operation.o : "add";
    const value = operation.v;

    if (kind === "patch" && Array.isArray(value)) {
      for (const nested of value) applyOperation(nested);
      return;
    }

    // A message object with no path is a new turn in the transcript.
    if (path === "" && typeof value === "object" && value !== null && value.message) {
      turns.push(value.message);
      return;
    }
    if (turns.length === 0) return;
    const message = turns[turns.length - 1];
    const parts = path.split("/").filter(Boolean);
    // A patch inside a turn is addressed from the message root.
    const target = parts[0] === "message" ? parts.slice(1) : parts;
    if (target.length === 0) {
      if (typeof value === "object" && value !== null) Object.assign(message, value);
      return;
    }

    let node = message;
    for (const part of target.slice(0, -1)) {
      const child = node[part];
      if (child === null || typeof child !== "object") {
        node[part] = /^\d+$/.test(target[target.indexOf(part) + 1] ?? "") ? [] : {};
      }
      node = node[part];
    }
    const last = target[target.length - 1];
    const previous = node[last];
    if (kind === "remove") {
      delete node[last];
      return;
    }
    if (kind === "append") {
      // Append concatenates: a string grows, an array gains an element, an
      // object merges.
      if (typeof previous === "string" && typeof value === "string") node[last] = previous + value;
      else if (Array.isArray(previous) && Array.isArray(value)) node[last] = [...previous, ...value];
      else if (previous && typeof previous === "object" && value && typeof value === "object") {
        node[last] = { ...previous, ...value };
      } else if (previous === undefined) node[last] = value;
      else if (previous === null || previous === "") node[last] = value;
      else if (Array.isArray(previous)) previous.push(value);
      else node[last] = value;
      return;
    }
    node[last] = value;
  };

  for (const rawLine of String(sseBody ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof parsed === "string") continue;
    applyOperation(parsed);
  }

  // The last assistant message that is prose. A reasoning recap is a different
  // `content_type` and is not the answer, and the user's own turn is not the
  // answer either.
  let lastText = "";
  for (const turn of turns) {
    const author = turn?.author;
    if (author?.role !== "assistant") continue;
    const content = turn?.content;
    if (content?.content_type !== undefined && content.content_type !== "text") continue;
    const raw = content?.parts ?? content?.content;
    if (raw === null || raw === undefined) continue;
    const parts = Array.isArray(raw)
      ? raw
      : typeof raw === "object"
        ? Object.entries(raw)
            .filter(([key]) => /^\d+$/.test(key))
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([, value]) => value)
        : [];
    const text = parts
      .map((part) =>
        typeof part === "string"
          ? part
          : (part?.content ?? part?.text ?? ""),
      )
      .join("")
      .trim();
    if (text) lastText = text;
  }
  return lastText;
}

/* ------------------------------------------------------------------ *
 * The request
 * ------------------------------------------------------------------ */

/**
 * Flattens an OpenAI message list into the one prompt a browser turn carries.
 *
 * The page gets a prompt, not a message list it has nowhere to put: the
 * system turn and the final turn are folded together, and the earlier turns
 * are the page's own transcript rather than something this request can carry.
 */
export function flattenMessages(messages) {
  const system = [];
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role || "user");
    const text = messageText(message?.content);
    if (!text.trim()) continue;
    if (role === "system" || role === "developer") {
      system.push(text);
      continue;
    }
    if (role === "user" || role === "assistant") turns.push({ role, text });
  }
  const last = turns[turns.length - 1];
  const prompt = [system.join("\n\n"), last?.text ?? ""].filter(Boolean).join("\n\n");
  return { prompt, history: turns.slice(0, -1) };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

/** The status and the error type each failure kind is reported with. */
const ERROR_KINDS = {
  INVALID_REQUEST: { status: 400, type: "invalid_request" },
  AUTHENTICATION_FAILED: { status: 401, type: "authentication_error" },
  PROVIDER_UNAVAILABLE: { status: 503, type: "provider_unavailable" },
  PROVIDER_REQUEST_FAILED: { status: 502, type: "upstream_error" },
  INVALID_RESPONSE: { status: 502, type: "upstream_error" },
};

export class ChatGptWebExecutor extends BaseExecutor {
  constructor() {
    // The registry entry owns the transport; the fallback keeps the executor
    // usable before the registry index is regenerated.
    super("chatgpt-web", PROVIDERS["chatgpt-web"] || registryEntry.transport);
  }

  /**
   * The page.
   *
   * There is no upstream endpoint to call — the browser opens the app and the
   * app makes its own request — so this is the URL the request log shows.
   */
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return CHATGPT_WEB_BASE_URL;
  }

  /**
   * The browser's own headers.
   *
   * The credential is deliberately **not** here: it is injected into the
   * browser's cookie jar, because the page — not this process — makes the
   * request that carries it. A `Cookie` header would only end up in the
   * request log, and the request log is written to disk with its headers
   * unmasked.
   */
  buildHeaders(credentials, stream = true) {
    return browserFingerprintHeaders({
      origin: CHATGPT_WEB.origin,
      referer: `${CHATGPT_WEB.origin}/`,
      accept: "text/event-stream",
    });
  }

  /**
   * The request the page is driven with.
   *
   * The body is the client's OpenAI request; the page takes one turn, so the
   * flattening into a prompt happens here, where the model the page will be
   * given is decided.
   */
  transformRequest(model, body, stream, credentials) {
    const selection = resolveChatGptWebSelection(model, body?.reasoning_effort);
    if (!selection) return body;
    const direct = chatGptWebDirectModel(selection);
    const { prompt } = flattenMessages(body?.messages);
    return { prompt, model: direct.model, reason: direct.reason };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl(model, stream, 0, credentials);
    const headers = this.buildHeaders(credentials, stream);
    const messages = body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return this.errorResult(url, headers, body, 400, "Missing or empty messages array", "invalid_request", "INVALID_REQUEST");
    }

    const selection = resolveChatGptWebSelection(model, body?.reasoning_effort);
    if (!selection) {
      return this.errorResult(
        url,
        headers,
        body,
        400,
        `ChatGPT Web does not offer a model called ${model}. The page's own picker is the authority — add it as a custom model id if it is listed there.`,
        "invalid_request",
        "NOT_SUPPORTED",
      );
    }

    const { prompt } = flattenMessages(messages);
    if (!prompt.trim()) {
      return this.errorResult(url, headers, body, 400, "Empty prompt after processing", "invalid_request", "INVALID_REQUEST");
    }

    const direct = chatGptWebDirectModel(selection);
    const transformedBody = { prompt, model: direct.model, reason: direct.reason };
    log?.info?.("CHATGPT-WEB", `Turn to ${model} (wire=${direct.model}, reason=${direct.reason}), len=${prompt.length}`);

    let text;
    try {
      // The pasted credential is the session, held as one opaque blob.
      const session = chatGptWebSessionFromCredential(credentials?.apiKey || credentials?.accessToken);
      const profile = profileFor(credentials);
      text = await askChatGpt({
        cookies: session.cookies,
        prompt,
        model: direct.model,
        reason: direct.reason,
        profile,
        signal,
        proxyOptions,
        log,
      });
    } catch (error) {
      const kind = ERROR_KINDS[error?.code] || ERROR_KINDS.PROVIDER_REQUEST_FAILED;
      const message = error instanceof Error ? error.message : "The ChatGPT page could not be driven.";
      log?.warn?.("CHATGPT-WEB", `${error?.code || "PROVIDER_REQUEST_FAILED"}: ${message}`);
      return this.errorResult(url, headers, transformedBody, kind.status, message, kind.type, error?.code || "PROVIDER_REQUEST_FAILED");
    }

    /**
     * Not trimmed, deliberately — the same reasoning as the DeepSeek Web
     * decoder, and found the same way: by the provider contract's
     * exact-equality assertion, whose hostile fixture ends in a single space.
     * Trimming here silently removed the leading and trailing whitespace of
     * every answer, so an answer asked to be exactly `"  indented  "` arrived
     * as `"indented"` and a code answer lost its trailing newlines. A client
     * cannot detect that; it looks like a short answer.
     */
    const cid = `chatcmpl-chatgpt-web-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(text.length / 4);

    if (stream) {
      /**
       * The answer arrives when the page has finished rendering it, so it is
       * presented as one chunk. Streaming a whole answer in one chunk is
       * honest about what happened — presenting it as tokens arriving over
       * time would imply a stream the provider does not have.
       */
      const encoder = new TextEncoder();
      const sseStream = new ReadableStream({
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
      return {
        response: new Response(sseStream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } }),
        url,
        headers,
        transformedBody,
        // The executor answers in OpenAI's shape; the translator turns that
        // into whatever the client speaks.
        responseFormat: "openai",
      };
    }

    return {
      response: new Response(
        JSON.stringify({
          id: cid,
          object: "chat.completion",
          created,
          model,
          system_fingerprint: null,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      url,
      headers,
      transformedBody,
      responseFormat: "openai",
    };
  }

  /**
   * An error, as the client sees it.
   *
   * Never thrown out of `execute`: the gateway turns a thrown error into a
   * generic 502, and these refusals are the difference between "copy a
   * fresher session" and "ChatGPT is unavailable".
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
      // The executor answers in OpenAI's shape; the translator turns that into
      // whatever the client speaks.
      responseFormat: "openai",
    };
  }
}

/**
 * Where this connection's browser profile lives.
 *
 * A persistent profile is not an optimisation, it is a requirement. ChatGPT
 * shows a first-use "Temporary Chat" modal, and with a throwaway profile it
 * is shown on *every* request — holding focus, intercepting the click on
 * Send, and turning a working flow into a timeout. A real browser remembers
 * that it has been dismissed, and so does this one. It is also the difference
 * between a 20-second page load and an instant one per turn.
 */
function profileFor(credentials) {
  const key = credentials?.connectionId || credentials?.connectionName || "default";
  return profileDir("chatgpt-web", key);
}

/**
 * A refusal can arrive with HTTP 200 and a body, so the status is never
 * trusted on its own.
 *
 * The conversation normally answers with an event stream, so a JSON body
 * means the request was refused rather than served — and a refusal that is
 * only visible in the body is a refusal that would otherwise be reported as
 * an empty answer.
 */
export function refusalFromBody(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return readBodyRefusal(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/**
 * One turn, through the page.
 *
 * The page is opened once, the turn is made through ChatGPT's own request
 * path, and the answer is read back out of the response stream.
 */
async function askChatGpt({ cookies, prompt, model, reason, profile, signal, proxyOptions, log }) {
  const { page, close } = await openChatGptPage(cookies, profile);
  try {
    /**
     * One retry for a dropped connection, and only for that.
     *
     * The turn runs inside the page, and a fetch ChatGPT's own code makes
     * can fail on the network — `Failed to fetch` from its Sentinel or
     * Turnstile solve. That is indistinguishable, to the caller, from a real
     * refusal, and it is not one: it succeeds on a second attempt. Anything
     * else is a real failure and is raised as one, so a broken session is not
     * retried into looking intermittent.
     */
    let text = "";
    let lastError = null;
    for (let attempt = 1; attempt <= 2 && !text; attempt += 1) {
      try {
        const sse = await withTurnDeadline(
          executeFirstPartyTurn(page, { prompt, model, reason }, proxyOptions),
          signal,
          CHATGPT_WEB.defaultTurnTimeoutMs,
        );
        const refusal = refusalFromBody(sse);
        if (refusal) {
          throw new ChatGptWebError("PROVIDER_REQUEST_FAILED", `ChatGPT refused the turn — ${refusal}.`);
        }
        text = extractAssistantText(sse);
        if (!text) {
          // Not retried: a stream with no text is a format change, not a
          // dropped connection, and retrying it would hide a real break
          // behind a slow failure.
          throw new ChatGptWebError(
            "PROVIDER_REQUEST_FAILED",
            "ChatGPT answered, but the stream carried no text. Its response format may have changed.",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transient = /Failed to fetch|ERR_NETWORK_CHANGED|NetworkError|load failed/i.test(message);
        lastError = error instanceof Error ? error : new Error(message);
        if (!transient || attempt === 2) throw lastError;
        log?.info?.("CHATGPT-WEB", `Transient page failure, retrying: ${message}`);
        await page.waitForTimeout(3_000).catch(() => undefined);
      }
    }
    return text;
  } finally {
    // The profile persists, so the context is what gets closed.
    await close();
  }
}

/**
 * The turn's own deadline, and the client's own abort.
 *
 * A browser turn is minutes-scale, so a request that never comes back has to
 * end somewhere rather than hold a connection open.
 */
function withTurnDeadline(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ChatGptWebError(
          "PROVIDER_REQUEST_FAILED",
          `The ChatGPT page did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ChatGptWebError("PROVIDER_REQUEST_FAILED", "The request was aborted."));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new ChatGptWebError("PROVIDER_REQUEST_FAILED", "The request was aborted."));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export default ChatGptWebExecutor;
