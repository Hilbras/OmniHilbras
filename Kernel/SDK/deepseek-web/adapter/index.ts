import { ProviderError } from '../lib/errors.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, CredentialValidation, FinishReason, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderId, ProviderRequestContext, ToolCall, ToolCallDelta, ToolDefinition } from '../lib/types.js';
import { MAX_DEEPSEEK_POW_DIFFICULTY, findDeepSeekPowNonce } from '../lib/deepseek-pow.js';

/**
 * DeepSeek Web, driven by a `userToken` from a signed-in chat.deepseek.com.
 *
 * **No browser is needed for a turn.** The web client is an HTTP API behind a session token,
 * so unlike ChatGPT Web this is a normal fetch with a bearer credential. A browser is only
 * involved in *getting* the token, which the gateway does in a visible sign-in window.
 *
 * That difference is why this provider exists as it does: the fragile parts of a web-session
 * provider are all in obtaining the credential, and the request path is plain.
 *
 * Two things make the request path non-obvious, and both are load-bearing:
 *
 *  - **The token is exchanged, not used.** `userToken` only authorises `users/current`,
 *    which hands back a short-lived `accessToken` for everything else. Sending the userToken
 *    at the completion endpoint gets a 401 that looks like an expired session.
 *  - **Every completion is gated by a proof of work** — see `deepseek-pow.ts`. It is a
 *    bounded search, not a wall, and the answer goes in `X-Ds-Pow-Response`.
 */

export const deepseekWebProviderId: ProviderId = 'deepseek-web';

/**
 * The same sign-in web client, exposed under a second provider id so a connection can be pinned to
 * the 2.8.0 build's fingerprint without disturbing the provider that is live today.
 *
 * `deepseekWebProviderId` stays the 2.0.0 request shape byte for byte; only `variant: 'v2'` sends
 * the newer headers, the `action` field and reads the server-delivered model catalogue.
 */
export const deepseekWebV2ProviderId: ProviderId = 'deepseek-web-v2';

const WEB_ORIGIN = 'https://chat.deepseek.com';
const API_BASE = `${WEB_ORIGIN}/api`;
const COMPLETION_URL = `${API_BASE}/v0/chat/completion`;
const SETTINGS_URL = `${API_BASE}/v0/client/settings`;

/**
 * The fingerprint the web client sends on every `/api/v0/*` call.
 *
 * The header set is a bot-detection signal in itself, not decoration: the 2.0.0 web build
 * dropped `X-App-Version` and added `X-Client-Bundle-Id`, so sending the *stale* stamp is
 * itself suspicious. These are the ones the current build sends.
 *
 * `x-hif-leim`, a signed client-attestation token from obfuscated JS, is deliberately
 * omitted — reproducing it means porting that JS, and the completion endpoint does not
 * currently require it. If it ever does, requests will fail with a 401 that says nothing
 * about attestation, which is when to come back to it.
 */
const FINGERPRINT_HEADERS: Readonly<Record<string, string>> = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: WEB_ORIGIN,
  Referer: `${WEB_ORIGIN}/`,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'X-Client-Bundle-Id': 'com.deepseek.chat',
  'X-Client-Locale': 'en-US',
  'X-Client-Platform': 'web',
  'X-Client-Version': '2.0.0',
};

/**
 * The fingerprint the live 2.8.0 client sends, from `docs/reports/deepseek-web-capture.md`.
 *
 * Only the parts that changed are written here. The capture shows the client also sending, on every
 * `/api/v0/*` call, a UUID `x-device-id` and an **empty** `x-device-model`; both are per-instance
 * (a device id identifies a device, not a build) so the constructor adds them, generated once.
 *
 * `x-client-locale` is `en_US` with an underscore — the newer build's own spelling, not a cosmetic
 * variant of v1's `en-US`.
 */
const V2_FINGERPRINT_HEADERS: Readonly<Record<string, string>> = {
  ...FINGERPRINT_HEADERS,
  'X-Client-Locale': 'en_US',
  'X-Client-Version': '2.8.0',
};

export const DEEPSEEK_WEB = {
  origin: WEB_ORIGIN,
  apiBase: API_BASE,
  /** The localStorage key the web client keeps its session token under. */
  tokenStorageKey: 'userToken',
  navigationTimeoutMs: 60_000,
} as const;

/**
 * The models chat.deepseek.com serves.
 *
 * Two axes, and both are in the id rather than a separate parameter: `think` and `search`
 * are model variants the page offers, not request options. A Pro model is `model_type:
 * "expert"`; everything else is `"default"`.
 */
const DEEPSEEK_WEB_MODELS: ReadonlyArray<{ id: string; name: string; expert: boolean; thinking: boolean; search: boolean }> = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', expert: true, thinking: false, search: false },
  { id: 'deepseek-v4-pro-think', name: 'DeepSeek V4 Pro Think', expert: true, thinking: true, search: false },
  { id: 'deepseek-v4-pro-search', name: 'DeepSeek V4 Pro Search', expert: true, thinking: false, search: true },
  { id: 'deepseek-v4-pro-think-search', name: 'DeepSeek V4 Pro Think+Search', expert: true, thinking: true, search: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', expert: false, thinking: false, search: false },
  { id: 'deepseek-v4-flash-think', name: 'DeepSeek V4 Flash Think', expert: false, thinking: true, search: false },
  { id: 'deepseek-v4-flash-search', name: 'DeepSeek V4 Flash Search', expert: false, thinking: false, search: true },
  { id: 'deepseek-v4-flash-think-search', name: 'DeepSeek V4 Flash Think+Search', expert: false, thinking: true, search: true },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', expert: false, thinking: false, search: false },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', expert: false, thinking: true, search: false },
  { id: 'DeepSeek-R1', name: 'DeepSeek R1', expert: false, thinking: true, search: false },
  { id: 'DeepSeek-R1-Search', name: 'DeepSeek R1 Search', expert: false, thinking: true, search: true },
  { id: 'DeepSeek-V3.2', name: 'DeepSeek V3.2', expert: false, thinking: false, search: false },
  { id: 'DeepSeek-Search', name: 'DeepSeek Search', expert: false, thinking: false, search: true },
];

/** Every id, plus the spelling variants that normalise to the same model. */
export function allDeepSeekWebModels(): string[] {
  return DEEPSEEK_WEB_MODELS.map((model) => model.id);
}

/**
 * Which built-in model a server-delivered `model_type` is.
 *
 * The settings endpoint names a model by type (`default`, `expert`) and a display name
 * (`Instant`, `Expert`), not by the id the completion endpoint takes. These are the ids the
 * built-in table gives those types, so a server entry refines a name rather than inventing a model
 * the adapter's `lookupModel` would refuse.
 */
const MODEL_TYPE_BASE: Readonly<Record<string, string>> = {
  default: 'deepseek-v4-flash',
  expert: 'deepseek-v4-pro',
};

type ServerModelConfig = { modelType: string; name?: string };

function isModelDescriptor(value: unknown): value is { model_type: string; name?: unknown } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { model_type?: unknown }).model_type === 'string' &&
    (value as { model_type: string }).model_type.length > 0
  );
}

/**
 * Reads the model catalogue out of `GET /api/v0/client/settings?scope=model`.
 *
 * The capture (`deepseek-web-captures/auth.json`) shows:
 *
 * ```json
 * {"code":0,"data":{"biz_code":0,"biz_data":{"settings":{
 *   "model_configs":{"id":…,"value":[{"model_type":"default","name":"Instant",…},
 *                                     {"model_type":"expert","name":"Expert",…},
 *                                     {"model_type":"vision","name":"Vision",…}]}}}}}
 * ```
 *
 * The shape is walked rather than indexed down a fixed path — the settings map is server-shaped
 * and has grown keys before — and anything unexpected returns `null` so the caller falls back to
 * the built-in table instead of throwing on a response nobody has seen yet.
 */
function readServerModelConfigs(json: unknown): ServerModelConfig[] | null {
  const data = (json as { data?: { biz_data?: { settings?: unknown } } } | null)?.data?.biz_data;
  const settings = data?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;

  // `model_configs.value` is the captured shape; other settings entries may also carry arrays, so
  // every candidate is inspected and the first list of model descriptors wins.
  const candidates: unknown[][] = [];
  for (const value of Object.values(settings as Record<string, unknown>)) {
    const inner = value && typeof value === 'object' && 'value' in value ? (value as { value?: unknown }).value : value;
    if (Array.isArray(inner)) candidates.push(inner as unknown[]);
  }

  for (const candidate of candidates) {
    const descriptors = candidate.filter(isModelDescriptor);
    if (descriptors.length === 0 || descriptors.length !== candidate.length) continue;
    return descriptors.map((entry) => ({
      modelType: entry.model_type,
      ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}),
    }));
  }
  return null;
}

const DSML_TOOLS_INSTRUCTION = `[SYSTEM INSTRUCTION: TOOLS AVAILABLE]
You have access to the following tools:
{{TOOLS}}

When you need to execute a tool, write your response in this exact format (do not add spaces inside tag delimiters):
<||DSML|| calls>
<||DSML|| invoke name="tool_name">
<||DSML|| parameter name="arg_name" string="true">value</||DSML|| parameter>
</||DSML|| invoke>
</||DSML|| calls>`;

/**
 * Normalizes the DSML tags a DeepSeek model may emit.
 *
 * The model sometimes uses fullwidth vertical bars, spacing around the bars, or lower-case
 * tags. The canonical form is what the parser and the reply history use.
 */
export function normalizeDeepSeekDsml(text: string): string {
  if (!text) return '';
  return text
    .replace(/｜/g, '|')
    .replace(/<\s*(\/?)\s*\|*[\s|]*DSML[\s|]*\|*\s*/gi, '<$1||DSML|| ');
}

/**
 * Parses the prompt-level tool protocol used by DeepSeek's chat page.
 *
 * This is not native function calling: the model is asked to emit a DSML block, and the
 * adapter turns it back into OpenAI tool calls. Parsing is deliberately strict about the
 * invoke name and tolerant about whitespace, because a partial tag must not become a tool
 * call with an empty name.
 */
export function parseDeepSeekDsml(text: string): { content: string; toolCalls: ToolCall[] } | null {
  if (!text) return null;
  const normalized = normalizeDeepSeekDsml(text);
  if (!/<\|+DSML\|+\s*invoke\b/i.test(normalized)) return null;

  const firstTag = normalized.match(/<\|+DSML\|+\s*(?:calls|tool_calls|invoke)[^>]*>/i);
  const content = firstTag ? normalized.slice(0, firstTag.index).trim() : '';
  const toolCalls: ToolCall[] = [];
  const invokeRegex = /<\|+DSML\|+\s*invoke\b([^>]*)>([\s\S]*?)(?:<\/\|+DSML\|+\s*invoke[^>]*>|(?=<\|+DSML\|+\s*invoke\b)|<\/\|+DSML\|+\s*(?:calls|tool_calls)[^>]*>|$)/gi;
  let invoke: RegExpExecArray | null;
  while ((invoke = invokeRegex.exec(normalized)) !== null) {
    const attrs = invoke[1] ?? '';
    const name = /\bname=["']?([^"'\s>]+)["']?/i.exec(attrs)?.[1];
    if (!name) continue;
    const body = invoke[2] ?? '';
    const args: Record<string, unknown> = {};
    const paramRegex = /<\|+DSML\|+\s*parameter\b([^>]*)>([\s\S]*?)(?:<\/\|+DSML\|+\s*parameter[^>]*>|(?=<\|+DSML\|+\s*parameter\b)|<\/\|+DSML\|+\s*invoke[^>]*>|$)/gi;
    let param: RegExpExecArray | null;
    while ((param = paramRegex.exec(body)) !== null) {
      const paramAttrs = param[1] ?? '';
      const paramName = /\bname=["']?([^"'\s>]+)["']?/i.exec(paramAttrs)?.[1];
      if (!paramName) continue;
      const rawValue = param[2]?.trim() ?? '';
      const forcedString = /\bstring\s*=\s*["']?true["']?/i.test(paramAttrs);
      if (forcedString) {
        args[paramName] = rawValue;
        continue;
      }
      try {
        args[paramName] = JSON.parse(rawValue);
      } catch {
        args[paramName] = rawValue;
      }
    }
    toolCalls.push({
      id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  if (toolCalls.length === 0) return null;
  return { content, toolCalls };
}

function formatToolCalls(toolCalls: readonly ToolCall[]): string {
  const calls = toolCalls.map((toolCall) => {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(toolCall.function.arguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = { raw: toolCall.function.arguments };
    }
    const params = Object.entries(args)
      .map(([name, value]) => `<||DSML|| parameter name="${name}" string="true">${typeof value === 'string' ? value : JSON.stringify(value)}</||DSML|| parameter>`)
      .join('\n');
    return `<||DSML|| invoke name="${toolCall.function.name}">\n${params}\n</||DSML|| invoke>`;
  });
  return `<||DSML|| calls>\n${calls.join('\n')}\n</||DSML|| calls>`;
}

/**
 * Builds the one flat prompt the endpoint accepts, with tool replay and bounded history.
 *
 * This is intentionally separate from `flattenToPrompt`: that function is the simple
 * text-only contract covered by older tests. An agent turn needs assistant tool calls and
 * tool results in the transcript, and those do not exist in the text-only shape.
 */
export function buildDeepSeekPrompt(messages: readonly ChatMessage[], tools: readonly ToolDefinition[] = [], toolChoice: ChatRequest['toolChoice'] = 'auto'): string {
  const parts: string[] = [];
  if (tools.length > 0) {
    const instruction = DSML_TOOLS_INSTRUCTION.replace('{{TOOLS}}', JSON.stringify(tools, null, 2));
    parts.push(toolChoice === 'required' ? `${instruction}\n\nYou must call at least one tool before answering.` : instruction);
  }

  const text = messages.map((message) => {
    const content = messageText(message.content);
    const calls = message.toolCalls?.length ? formatToolCalls(message.toolCalls) : '';
    return { message, content, calls };
  });
  const totalLength = text.reduce((sum, item) => sum + item.content.length + item.calls.length, 0);
  const isLarge = totalLength > 60_000;
  const recentThreshold = Math.max(0, messages.length - 12);

  for (let index = 0; index < text.length; index += 1) {
    const { message, calls } = text[index]!;
    let content = text[index]!.content;
    // The newest window is never truncated, and the current user turn must survive verbatim.
    if (isLarge && index < recentThreshold) {
      if (message.role === 'tool') {
        if (content.length > 1200) content = `${content.slice(0, 1200)}\n...[truncated ${content.length - 1200} characters for context limit]...`;
      } else if (content.length > 3000) {
        content = `${content.slice(0, 3000)}\n...[truncated ${content.length - 3000} characters for context limit]...`;
      }
    }
    if (message.role === 'system') {
      parts.push(`SYSTEM: ${content}`);
    } else if (message.role === 'tool') {
      parts.push(`[TOOL RESULT for ${message.name || message.toolCallId || 'tool'}]:${message.isError ? ' [ERROR]' : ''}\n${content}`);
    } else if (calls) {
      parts.push(`${message.role.toUpperCase()}${content ? `: ${content}` : ''}\n${calls}`);
    } else {
      parts.push(`${message.role.toUpperCase()}: ${content}`);
    }
  }
  return parts.join('\n\n').trim();
}

function lookupModel(id: string) {
  const wanted = id.trim().toLowerCase();
  return DEEPSEEK_WEB_MODELS.find((model) => model.id.toLowerCase() === wanted);
}

export const MAX_DEEPSEEK_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DEEPSEEK_IMAGES = 4;

type DeepSeekImage = { bytes: Uint8Array; mimeType: string; filename: string };

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

export function parseDeepSeekDataImage(url: string): DeepSeekImage | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
  if (!match) return null;
  const mimeType = match[1]!.toLowerCase();
  if (!IMAGE_MIME.test(mimeType)) return null;
  // Base64 expands by 4/3; reject before allocating the decoded buffer.
  if (Math.ceil((match[2]!.length * 3) / 4) > MAX_DEEPSEEK_IMAGE_BYTES) {
    throw fail('INVALID_REQUEST', `DeepSeek Web accepts images up to ${MAX_DEEPSEEK_IMAGE_BYTES / (1024 * 1024)} MB.`);
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(match[2]!);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    throw fail('INVALID_REQUEST', 'That image data URI is not valid base64.');
  }
  if (bytes.byteLength > MAX_DEEPSEEK_IMAGE_BYTES) {
    throw fail('INVALID_REQUEST', `DeepSeek Web accepts images up to ${MAX_DEEPSEEK_IMAGE_BYTES / (1024 * 1024)} MB.`);
  }
  return { bytes, mimeType, filename: `image.${imageExtension(mimeType)}` };
}

function imageExtension(mimeType: string): string {
  if (/jpe?g/i.test(mimeType)) return 'jpg';
  if (/webp/i.test(mimeType)) return 'webp';
  if (/gif/i.test(mimeType)) return 'gif';
  return 'png';
}

/** Remote images are https-only and must not target the local machine or a private range. */
export function isDeepSeekImageUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host === '[::1]' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return true;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

export function extractDeepSeekImageUrls(messages: readonly ChatMessage[]): string[] {
  const urls: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || part.type !== 'image_url') continue;
      const candidate = part.imageUrl?.url ?? (part as { image_url?: { url?: string } }).image_url?.url;
      if (typeof candidate === 'string' && candidate) urls.push(candidate);
    }
  }
  return urls;
}

/**
 * Reads the token out of whatever the user pasted.
 *
 * DeepSeek stores it as `{"value":"…"}`, so a copy out of localStorage is sometimes the
 * wrapper and sometimes the bare string. Accepting both is the difference between "paste it"
 * working and "paste it" working only if you know to unwrap it first.
 */
export function parseDeepSeekUserToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste the userToken from chat.deepseek.com.', {
      providerId: deepseekWebProviderId,
      publicMessage: 'Paste the userToken from chat.deepseek.com.',
    });
  }
  // A pasted request line is the commonest mistake and reads as a nonsense credential,
  // so it is refused with a message that says what to copy.
  if (/^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH)\s+\//i.test(trimmed)) {
    throw new ProviderError('INVALID_REQUEST', 'That is a request line, not a userToken. Copy the value of localStorage\'s userToken only.', {
      providerId: deepseekWebProviderId,
      publicMessage: 'That is a request line, not a userToken. Copy the value of localStorage\'s userToken only.',
    });
  }
  if (trimmed.startsWith('{')) {
    /**
     * The wrapper is `{"value":"…","__version":N}` — and **signed out it is
     * `{"value":null}`**, which is exactly what a page that is not signed in stores.
     *
     * Falling through to "treat the raw string as the token" turned that null wrapper into a
     * credential: it looked like a token, it was accepted, and the failure surfaced much later
     * as DeepSeek refusing a session nobody could explain. An empty value is the single most
     * likely thing to be handed here, so it is named rather than passed along.
     */
    let parsed: { value?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { value?: unknown };
    } catch {
      // Not the wrapper at all; a bare token is fine.
      return trimmed;
    }
    if (typeof parsed.value === 'string' && parsed.value.trim()) return parsed.value.trim();
    // No `value` key at all means this was never the wrapper — some other object, pasted by
    // mistake or from somewhere else. That is not the signed-out state, so it is used as-is
    // rather than being told to sign in.
    if (!('value' in parsed)) return trimmed;
    const message =
      'That userToken is empty, which is what chat.deepseek.com stores when you are not signed in. Open chat.deepseek.com, sign in, and copy it again.';
    throw new ProviderError('AUTHENTICATION_FAILED', message, {
      providerId: deepseekWebProviderId,
      publicMessage: message,
    });
  }
  return trimmed;
}

export function deepSeekWebCredential(raw: string): ProviderCredential {
  return { type: 'api-key', value: parseDeepSeekUserToken(raw) };
}

/**
 * Turns a non-ok status into the refusal it actually is.
 *
 * Every endpoint in this adapter's four-step flow goes through here, because the alternative was
 * the bug this replaces: `users/current` and `completion` mapped 401 to `AUTHENTICATION_FAILED`
 * while `create_pow_challenge` and `chat_session/create` mapped the *same* 401 to
 * `PROVIDER_UNAVAILABLE`. Which branch a user hit therefore depended on whether the access token
 * happened to be cached — invisible state deciding whether a dead session reads as "sign in again"
 * or as "the provider is down".
 *
 * The second mapping is the costly one. `PROVIDER_UNAVAILABLE` is retryable, so the router would
 * fail over to another provider for a session that can never recover, and the dashboard would show
 * a provider outage where the truth is an expired cookie.
 */
function refusalFor(status: number, what: string, onExpired?: () => void) {
  if (status === 401 || status === 403) {
    // The cached token is known bad now, so dropping it stops the next request from being sent
    // with a credential the provider has already refused.
    onExpired?.();
    return fail(
      'AUTHENTICATION_FAILED',
      `DeepSeek refused this session while ${what} (${status}). Sign in to chat.deepseek.com again and export a fresh userToken.`,
    );
  }
  if (status === 429) {
    const message = `DeepSeek is rate limiting this session (${status}) while ${what}.`;
    return new ProviderError('RATE_LIMITED', message, { providerId: deepseekWebProviderId, publicMessage: message, retryable: true });
  }
  return fail('PROVIDER_UNAVAILABLE', `DeepSeek answered ${status} while ${what}.`);
}

function userTokenFromCredential(credential: ProviderCredential | undefined): string {
  if (!credential || credential.type !== 'api-key' || !credential.value.trim()) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'This DeepSeek Web connection has no userToken.', {
      providerId: deepseekWebProviderId,
      publicMessage: 'This DeepSeek Web connection has no userToken. Sign in again.',
    });
  }
  return credential.value.trim();
}

/** One place to build a provider error, so every failure carries the id and the public message. */
function fail(code: ProviderError['code'], message: string): ProviderError {
  return new ProviderError(code, message, { providerId: deepseekWebProviderId, publicMessage: message });
}

/** DeepSeek wraps every response in `{ code, msg, data: { biz_data } }` and `code !== 0` means trouble. */
function unwrap(json: unknown, what: string): Record<string, unknown> {
  const refusal = bodyRefusal(json);
  if (refusal) throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek refused the ${what}: ${refusal}`);
  const body = (json ?? {}) as { code?: unknown; msg?: unknown; data?: { biz_data?: Record<string, unknown>; biz_msg?: string } };
  if (typeof body.code === 'number' && body.code !== 0) {
    const message = typeof body.msg === 'string' && body.msg ? body.msg : (body.data?.biz_msg ?? `error code ${body.code}`);
    throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek rejected the ${what}: ${message}`);
  }
  const biz = body.data?.biz_data;
  if (!biz || typeof biz !== 'object') throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek returned no data for the ${what}.`);
  return biz;
}

/**
 * The refusal shapes other web providers use, accepted here too.
 *
 * DeepSeek's own errors are the `{ code, data: { biz_data } }` shape below, but a
 * proxy or a changed web route can answer `{ success: false, data: { code } }` or
 * `{ ret: [...] }`. The old implementation read both; dropping that reader made
 * those answers look like an empty success.
 */
function bodyRefusal(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const record = json as { success?: unknown; ret?: unknown; code?: unknown; details?: unknown; data?: { code?: unknown; details?: unknown } };
  if (record.success !== false) {
    const ret = Array.isArray(record.ret) ? record.ret : undefined;
    return ret && ret.length > 0 ? `refused: ${ret.join(', ')}` : undefined;
  }
  const code = record.data?.code ?? record.code;
  const details = record.data?.details ?? record.details;
  return [typeof code === 'string' ? code : undefined, typeof details === 'string' ? details : undefined]
    .filter(Boolean)
    .join(' — ') || 'refused';
}

type AccessToken = { token: string; expiresAt: number };

const SESSION_TTL_MS = 15 * 60_000;
const SESSION_MAX = 100;

/** FNV-1a over the credential, so the cache is not keyed by a secret in plain sight. */
function sessionCacheKey(userToken: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < userToken.length; index += 1) {
    hash ^= userToken.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export class DeepSeekWebAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  /**
   * Streaming is served as one completed chunk, not token-by-token.
   *
   * DeepSeek's answer must be read to `FINISHED` before it can be trusted — a body that closes
   * early is a cut-off answer, not a short one — so the old executor decoded the whole turn and
   * replayed it as role/content/stop chunks. That is what this advertises: a stream request works,
   * and the spec says the content arrives at once rather than pretending it arrived incrementally.
   */
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  /** `v2` is the 2.8.0 web build's request shape; `v1` is the live 2.0.0 shape, unchanged. */
  private readonly variant: 'v1' | 'v2';
  /** The fingerprint for this instance: v1's set verbatim, or v2's plus the device id. */
  private readonly headers: Readonly<Record<string, string>>;
  /**
   * A device id is per device, not per request, so it is generated once and reused — the capture
   * shows the live client sending the same UUID across calls. Only v2 sends it; v1 sends none.
   */
  private readonly deviceId: string;
  /** Keyed by userToken, because the access token is per-account and lasts about an hour. */
  private readonly accessTokens = new Map<string, AccessToken>();
  /** Session ids, keyed by a hash of the userToken; never by the raw credential. */
  private readonly sessions = new Map<string, { id: string; at: number }>();

  constructor(options: { now?: () => number; fetch?: typeof fetch; variant?: 'v1' | 'v2' } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? fetch;
    this.variant = options.variant ?? 'v1';
    this.id = this.variant === 'v2' ? deepseekWebV2ProviderId : deepseekWebProviderId;
    this.name = this.variant === 'v2' ? 'DeepSeek Web V2' : 'DeepSeek Web';
    this.deviceId = crypto.randomUUID();
    this.headers =
      this.variant === 'v2'
        ? { ...V2_FINGERPRINT_HEADERS, 'X-Device-Id': this.deviceId, 'X-Device-Model': '' }
        : FINGERPRINT_HEADERS;
  }

  /**
   * The headers for one request.
   *
   * A connection that signed in through the desktop window carries the **web client's own** device id,
   * captured from the page that signed in. When it does, that value is what goes out — a request that
   * claims a different device than the one the session was minted on is exactly the kind of difference
   * this provider exists to remove. Without it, the per-instance id stands in, which is stable but not
   * the client's, and is the honest fallback rather than a pretence.
   */
  private headersFor(credential?: ProviderCredential): Readonly<Record<string, string>> {
    const deviceId = credential?.type === 'api-key' ? credential.deviceId : undefined;
    if (!deviceId || this.variant !== 'v2') return this.headers;
    return { ...this.headers, 'X-Device-Id': deviceId };
  }

  /** The device id to name on settings calls: the connection's, else this instance's. */
  private didFor(credential?: ProviderCredential): string {
    const captured = credential?.type === 'api-key' ? credential.did : undefined;
    return captured ?? this.deviceId;
  }

  /**
   * The built-in table, refined by the server's own catalogue for v2.
   *
   * The capture shows where the client's model choice lives: server-delivered settings, not a field
   * on the completion request. So v2 asks `client/settings?scope=model` first, and maps each
   * `model_type` onto the built-in id that type already corresponds to, taking the server's display
   * name (`Instant`, `Expert`). Everything else stays as the built-in table has it, so an endpoint
   * that is unreachable, answers a 500, throws, or returns a shape nobody has seen yet still leaves
   * the provider with its full, usable catalogue — the failure mode of a model list is not an empty
   * model list.
   *
   * A server entry whose `model_type` has no built-in counterpart (currently `vision`) is left out
   * rather than published: `chat` resolves ids against the built-in table, and a card the adapter
   * refuses is worse than a shorter list.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const builtIn: Model[] = DEEPSEEK_WEB_MODELS.map((model) => ({ id: model.id, providerId: this.id, displayName: model.name }));
    if (this.variant !== 'v2') return builtIn;
    const serverNames = await this.serverModelNames(context);
    if (!serverNames) return builtIn;
    return builtIn.map((model) => {
      const name = serverNames.get(model.id);
      return name ? { ...model, displayName: name } : model;
    });
  }

  /**
   * The server's display name per built-in id, or `null` when it cannot be had honestly.
   *
   * Every failure is `null`: no credential on the connection, a dead session, a network error, a
   * non-200, a body that is not JSON, or settings without a model list. `listModels` must not fail
   * because an auxiliary endpoint did.
   */
  private async serverModelNames(context: ProviderRequestContext): Promise<Map<string, string> | null> {
    let userToken: string;
    try {
      userToken = userTokenFromCredential(context.credential);
    } catch {
      return null;
    }
    try {
      const accessToken = await this.accessToken(userToken, context.signal, { credential: context.credential });
      const response = await this.fetchImpl(`${SETTINGS_URL}?did=${encodeURIComponent(this.didFor(context.credential))}&scope=model`, {
        method: 'GET',
        headers: { ...this.headers, Authorization: `Bearer ${accessToken}` },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!response.ok) return null;
      const configs = readServerModelConfigs(await response.json());
      if (!configs) return null;
      const names = new Map<string, string>();
      for (const config of configs) {
        const base = MODEL_TYPE_BASE[config.modelType.toLowerCase()];
        if (base && config.name && !names.has(base)) names.set(base, config.name);
      }
      return names.size > 0 ? names : null;
    } catch {
      return null;
    }
  }

  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    // A real call, because a token's only meaningful test is whether DeepSeek accepts it.
    // Cheap: `users/current` is a single round trip and needs no proof of work. It skips the
    // access-token cache, so "valid" means DeepSeek said so just now rather than an hour ago.
    await this.accessToken(userTokenFromCredential(credential), undefined, { fresh: true, credential });
    return { status: 'valid', checkedAt: new Date(this.now()).toISOString() };
  }

  /**
   * Exchanges the userToken for a short-lived access token.
   *
   * The userToken authorises this call and nothing else. Cached for an hour because it is
   * the same value for every request in that window, and a turn otherwise spends two
   * round trips before it sends anything.
   *
   * `fresh` skips that cache, and only the health check asks for it. A cache makes the check
   * cheap, but it also makes it meaningless: the dashboard reported "healthy in 0 ms" from a
   * cache entry that proved nothing, which is the same fault as every other confident
   * unverified answer in this area — it looks like a successful check because something was
   * returned. The point of a health check is to learn whether the credential works *now*.
   */
  private async accessToken(userToken: string, signal?: AbortSignal, options: { fresh?: boolean; credential?: ProviderCredential } = {}): Promise<string> {
    const cached = this.accessTokens.get(userToken);
    if (!options.fresh && cached && cached.expiresAt > this.now()) return cached.token;

    const response = await this.fetchImpl(`${API_BASE}/v0/users/current`, {
      method: 'GET',
      headers: { ...this.headersFor(options.credential), Authorization: `Bearer ${userToken}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      // The 401 here is a *user* token rather than an access token, and a token from another
      // account or a signed-out session looks exactly like a dead one, so this says so.
      if (response.status === 401 || response.status === 403) {
        throw fail(
          'AUTHENTICATION_FAILED',
          'DeepSeek rejected that userToken. Sign in to chat.deepseek.com again and export a fresh one — a token from another account or a signed-out session looks exactly like this.',
        );
      }
      throw refusalFor(response.status, 'exchanging the userToken for an access token');
    }

    const biz = unwrap(await response.json(), 'sign-in');
    const token = biz.token;
    if (typeof token !== 'string' || !token) {
      throw fail('AUTHENTICATION_FAILED', 'DeepSeek accepted the request but returned no access token.');
    }
    // A minute of slack, so a token cannot expire between the check and the request.
    this.accessTokens.set(userToken, { token, expiresAt: this.now() + 55 * 60_000 });
    return token;
  }

  /**
   * Solves a fresh proof of work for the completion endpoint.
   *
   * A challenge per completion, not per session: the answer is bound to the target path and
   * carries the challenge's own expiry, so caching one would be reusing spent work.
   */
  private async proofOfWork(accessToken: string, signal: AbortSignal | undefined, onAuthFailure: () => void, credential?: ProviderCredential): Promise<string> {
    const response = await this.fetchImpl(`${API_BASE}/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: { ...this.headersFor(credential), 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw refusalFor(response.status, 'issuing a proof of work', onAuthFailure);
    const challenge = unwrap(await response.json(), 'proof of work').challenge as
      | { algorithm?: string; challenge?: string; salt?: string; difficulty?: number; signature?: string; target_path?: string; expire_at?: number }
      | undefined;
    if (!challenge?.challenge || typeof challenge.salt !== 'string' || typeof challenge.difficulty !== 'number') {
      throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek returned a proof-of-work challenge with no answer in it.');
    }
    if (challenge.algorithm !== undefined && challenge.algorithm !== 'DeepSeekHashV1') {
      // A new hash would silently produce a wrong answer, which DeepSeek reports as a plain
      // 401. Saying which algorithm arrived is the difference between a fixable error and a
      // mystery.
      throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek changed its proof-of-work algorithm to ${challenge.algorithm}; this version solves DeepSeekHashV1.`);
    }
    const prefix = `${challenge.salt}_${challenge.expire_at ?? 0}_`;
    const nonce = findDeepSeekPowNonce(prefix, challenge.challenge, Math.min(challenge.difficulty, MAX_DEEPSEEK_POW_DIFFICULTY));
    if (nonce < 0) {
      throw fail(
        'PROVIDER_REQUEST_FAILED',
        `DeepSeek's proof of work had no answer within the range it announced (${challenge.difficulty}). The challenge may have expired before it was solved.`,
      );
    }
    return Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm ?? 'DeepSeekHashV1',
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: nonce,
        signature: challenge.signature,
        target_path: challenge.target_path ?? '/api/v2/chat/completion',
      }),
    ).toString('base64');
  }

  private async createSession(accessToken: string, signal: AbortSignal | undefined, onAuthFailure: () => void, credential?: ProviderCredential): Promise<string> {
    const response = await this.fetchImpl(`${API_BASE}/v0/chat_session/create`, {
      method: 'POST',
      headers: { ...this.headersFor(credential), 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw refusalFor(response.status, 'starting a chat session', onAuthFailure);
    const session = unwrap(await response.json(), 'chat session').chat_session as { id?: string } | undefined;
    if (!session?.id) throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek started no chat session.');
    return session.id;
  }

  /**
   * Reuses a session for a bounded window. The old proxy created one on every turn; a
   * coding agent sends many turns, and session creation is its own rate-limited endpoint.
   * The key is a hash, so the raw userToken is not held in a second map.
   */
  private async reuseOrCreateSession(
    userToken: string,
    accessToken: string,
    signal: AbortSignal | undefined,
    onAuthFailure: () => void,
    credential?: ProviderCredential,
  ): Promise<string> {
    const key = sessionCacheKey(userToken);
    const cached = this.sessions.get(key);
    if (cached && this.now() - cached.at < SESSION_TTL_MS) return cached.id;
    const id = await this.createSession(accessToken, signal, onAuthFailure, credential);
    this.sessions.set(key, { id, at: this.now() });
    if (this.sessions.size > SESSION_MAX) {
      for (const [candidate, entry] of this.sessions) {
        if (this.now() - entry.at >= SESSION_TTL_MS) this.sessions.delete(candidate);
      }
      while (this.sessions.size > SESSION_MAX) {
        const oldest = [...this.sessions.entries()].sort((left, right) => left[1].at - right[1].at)[0];
        if (!oldest) break;
        this.sessions.delete(oldest[0]);
      }
    }
    return id;
  }

  private async loadImage(url: string, signal: AbortSignal | undefined): Promise<DeepSeekImage> {
    const dataImage = parseDeepSeekDataImage(url);
    if (dataImage) return dataImage;
    if (!isDeepSeekImageUrlAllowed(url)) {
      throw fail('INVALID_REQUEST', 'Image URLs must use https and must not point at localhost or a private network.');
    }
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: requestSignal, redirect: 'error' });
    } catch (error) {
      throw fail('PROVIDER_REQUEST_FAILED', `DeepSeek Web could not fetch the image: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw fail('PROVIDER_REQUEST_FAILED', `The image URL answered HTTP ${response.status}.`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_DEEPSEEK_IMAGE_BYTES) {
      throw fail('INVALID_REQUEST', `DeepSeek Web accepts images up to ${MAX_DEEPSEEK_IMAGE_BYTES / (1024 * 1024)} MB.`);
    }
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_MIME.test(mimeType)) throw fail('INVALID_REQUEST', 'The image URL did not return a PNG, JPEG, WebP or GIF.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DEEPSEEK_IMAGE_BYTES) {
      throw fail('INVALID_REQUEST', `DeepSeek Web accepts images up to ${MAX_DEEPSEEK_IMAGE_BYTES / (1024 * 1024)} MB.`);
    }
    return { bytes, mimeType, filename: `image.${imageExtension(mimeType)}` };
  }

  private async uploadImage(
    image: DeepSeekImage,
    accessToken: string,
    sessionId: string,
    signal: AbortSignal | undefined,
    onAuthFailure: () => void,
  ): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([image.bytes.buffer as ArrayBuffer], { type: image.mimeType }), image.filename);
    const headers = {
      ...this.headers,
      Authorization: `Bearer ${accessToken}`,
      Referer: `${WEB_ORIGIN}/a/chat/s/${sessionId}`,
    };
    const response = await this.fetchImpl(`${API_BASE}/v0/file/upload_file`, {
      method: 'POST',
      headers,
      body: form,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw refusalFor(response.status, 'uploading an image', onAuthFailure);
    const biz = unwrap(await response.json(), 'image upload');
    const fileId = biz.id ?? biz.file_id;
    if (typeof fileId !== 'string' || !fileId) throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek uploaded the image but returned no file id.');

    // The upload endpoint can answer before the file is readable. Poll briefly; a readiness
    // failure is not fatal because the completion endpoint will report an unusable id.
    for (let poll = 0; poll < 4; poll += 1) {
      try {
        const status = await this.fetchImpl(`${API_BASE}/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`, {
          headers,
          ...(signal ? { signal } : {}),
        });
        if (status.ok) {
          const files = unwrap(await status.json(), 'image status').files;
          if (Array.isArray(files)) {
            const record = files.find((item) => item && typeof item === 'object' && (item as { id?: unknown }).id === fileId) as { status?: unknown } | undefined;
            const state = typeof record?.status === 'string' ? record.status.toUpperCase() : '';
            if (state && !['PENDING', 'UPLOADING', 'PROCESSING'].includes(state)) break;
          }
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return fileId;
  }

  /**
   * Reports whether the saved credential still works.
   *
   * Without this the provider's health is reported as `Health checks are not supported.` and
   * the dashboard's "Test provider" fails on a connection that can answer — which is exactly
   * what happened, and it looked like a broken credential rather than a missing method.
   *
   * A credential check, not a completion: it costs one round trip and no proof of work, which
   * is what makes it cheap enough to run on every health poll.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      return {
        status: 'unavailable', verified: 'credential',
        checkedAt: new Date(this.now()).toISOString(),
        // The provider's own words, because "not connected" tells the user nothing about
        // whether to sign in again or to wait.
        message: error instanceof Error ? error.message : 'The DeepSeek Web session could not be checked.',
      };
    }
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const model = lookupModel(request.model);
    if (!model) {
      throw new ProviderError('NOT_SUPPORTED', `DeepSeek Web does not offer a model called ${request.model}.`, {
        providerId: this.id,
        publicMessage: `DeepSeek Web does not offer a model called ${request.model}. The models it serves are the ones on this page.`,
      });
    }
    const userToken = userTokenFromCredential(context.credential);
    const accessToken = await this.accessToken(userToken, context.signal, { credential: context.credential });
    // One eviction for the whole flow: whichever of the three mid-flight endpoints answers 401,
    // the cached access token and session are now known bad and the next attempt must not reuse
    // them.
    const sessionKey = sessionCacheKey(userToken);
    const onAuthFailure = () => {
      this.accessTokens.delete(userToken);
      this.sessions.delete(sessionKey);
    };
    const sessionId = await this.reuseOrCreateSession(userToken, accessToken, context.signal, onAuthFailure);

    const imageUrls = extractDeepSeekImageUrls(request.messages);
    if (imageUrls.length > MAX_DEEPSEEK_IMAGES) {
      throw fail('INVALID_REQUEST', `DeepSeek Web accepts at most ${MAX_DEEPSEEK_IMAGES} images in one turn.`);
    }
    const refFileIds: string[] = [];
    for (const imageUrl of imageUrls) {
      const image = await this.loadImage(imageUrl, context.signal);
      refFileIds.push(await this.uploadImage(image, accessToken, sessionId, context.signal, onAuthFailure));
    }

    const pow = await this.proofOfWork(accessToken, context.signal, onAuthFailure, context.credential);

    /**
     * The endpoint takes one flat `prompt`, not a message array. `buildDeepSeekPrompt`
     * carries tool calls and tool results as well as ordinary turns, and bounds older
     * history; dropping either would make a coding agent answer as if it had never run.
     */
    const tools = request.toolChoice === 'none' ? [] : request.tools ?? [];
    const prompt = buildDeepSeekPrompt(request.messages, tools, request.toolChoice);

    const response = await this.fetchImpl(COMPLETION_URL, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Ds-Pow-Response': pow,
        'X-Client-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: model.expert ? 'expert' : 'default',
        prompt,
        ref_file_ids: refFileIds,
        thinking_enabled: model.thinking,
        search_enabled: model.search,
        // The live 2.8.0 client sends `action: null`; v1 omits it and stays byte-for-byte as it was.
        ...(this.variant === 'v2' ? { action: null } : {}),
        preempt: false,
        /**
         * The client's own Shumei device fingerprint, when the connection captured one at sign-in.
         *
         * The capture shows the live client sending it on every completion. It cannot be computed here —
         * it is the vendor's anti-bot SDK output — so it is taken from the page that signed in, and
         * omitted when that page had none. Omitting it has never produced a refusal; sending a made-up
         * value would be worse than either.
         */
        ...(this.variant === 'v2' && context.credential?.type === 'api-key' && context.credential.shumeiDeviceId
          ? { shumei_device_id: context.credential.shumeiDeviceId }
          : {}),
        /**
         * `shumei_device_id` is deliberately absent in both variants. The capture shows the client
         * sending a per-device Shumei fingerprint, but nothing here can produce one honestly (that
         * is the vendor's anti-bot SDK output, not a value we can compute), and no refusal from
         * omitting it has ever been observed. This is a known difference, not an oversight.
         */
      }),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    if (!response.ok) throw refusalFor(response.status, 'answering the completion', () => this.accessTokens.delete(userToken));

    const answer = decodeDeepSeekAnswer(await readBodyCapped(response, context.signal));
    // A body that closes without `response/status: "FINISHED"` was cut off mid-generation — an
    // expired session, a dropped connection, an anti-bot challenge. Reporting the fragment as a
    // complete answer with `finish_reason: stop` is the worst version of this: it looks like a
    // model that finished, and the text is silently missing its ending.
    if (!answer.finished) {
      throw fail(
        'PROVIDER_REQUEST_FAILED',
        `DeepSeek's stream ended before it finished generating — the answer was cut off after ${answer.content.length} characters. This is usually a dropped connection or an expired session. Try again.`,
      );
    }

    const parsed = tools.length > 0 ? parseDeepSeekDsml(answer.content) : null;
    if (!parsed && !answer.content) {
      throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek answered, but the stream carried no text. Its response format may have changed.');
    }
    const content = parsed ? parsed.content : answer.content;
    const message: ChatMessage = {
      role: 'assistant',
      content: parsed && !content ? null : content,
      ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
      ...(parsed?.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
    };
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = answer.usage > 0 ? answer.usage : Math.ceil((content.length + (parsed?.toolCalls.reduce((sum, call) => sum + call.function.arguments.length, 0) ?? 0)) / 4);
    return {
      id: `chatcmpl-${Math.floor(this.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}`,
      providerId: this.id,
      model: model.id,
      createdAt: new Date(this.now()).toISOString(),
      message,
      finishReason: (parsed?.toolCalls.length ? 'tool_calls' : 'stop') satisfies FinishReason,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        totalTokens: promptTokens + completionTokens,
        // The prompt side is a bytes/4 estimate; DeepSeek's accumulated usage is the provider's
        // own count for the output side. Marking the record estimated keeps the dashboard from
        // presenting a mixed figure as a measured one.
        estimated: true,
      },
    };
  }

  /**
   * One chunk, because the upstream answer is checked to `FINISHED` before it is returned.
   * See the capability note above; this is the same trade the old executor made.
   */
  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const response = await this.chat(request, context);
    const content = messageText(response.message.content);
    const toolCalls: ToolCallDelta[] | undefined = response.message.toolCalls?.map((toolCall, index) => ({
      index,
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
    }));
    yield {
      id: response.id,
      providerId: response.providerId,
      model: response.model,
      delta: {
        role: 'assistant',
        ...(content ? { content } : {}),
        ...(response.message.reasoning ? { reasoning: response.message.reasoning } : {}),
        ...(toolCalls?.length ? { toolCalls } : {}),
      },
      finishReason: response.finishReason,
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text ?? '');
      return '';
    })
    .join('');
}

/**
 * Flattens a message list into the single prompt the endpoint takes.
 *
 * Labelled rather than concatenated, because a bare join of `["You are terse.", "2+2?"]`
 * loses which was which.
 */
export function flattenToPrompt(messages: ReadonlyArray<{ role: string; text: string }>): string {
  const kept = messages.filter((message) => message.text.trim());
  const system = kept.filter((message) => message.role === 'system');
  const rest = kept.filter((message) => message.role !== 'system');
  const lines: string[] = [];
  if (system.length > 0) {
    lines.push('Follow these instructions:', ...system.map((message) => `- ${message.text.trim()}`), '');
  }
  for (const message of rest) {
    lines.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.text.trim()}`);
  }
  return lines.join('\n').trim();
}

/**
 * Reads a completed answer out of DeepSeek's SSE body.
 *
 * Two frame shapes arrive and both matter:
 *
 * ```json
 * {"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"…"}]}}}
 * {"p":"response/fragments","o":"append","v":[{"type":"ANSWER","content":"working"}]}
 * ```
 *
 * The first is a whole response with its fragments inline. The second appends more, and those
 * fragments often arrive **without a type**, addressed relative to the current message —
 * which is why `thinking_enabled` from the last whole response decides which side of the
 * reasoning/content split a bare fragment belongs to. Dropping that state and treating every
 * append as the answer is how a model that thinks first ends up answering with its
 * reasoning.
 */
/**
 * Reads a completed answer out of DeepSeek's SSE body.
 *
 * Captured from a live stream rather than assumed, and the shape is not what it looks like. A
 * real reply to "Count from 1 to 5" arrives as:
 *
 * ```text
 * data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"RESPONSE","content":"1"}]}}}
 * data: {"p":"response/fragments/-1/content","o":"APPEND","v":","}
 * data: {"v":" "}
 * data: {"v":"2"}
 * data: {"v":","}
 * data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":60}]}
 * data: {"p":"response/status","o":"SET","v":"FINISHED"}
 * ```
 *
 * **Only the first line is a fragment object.** The rest of the answer is a run of frames whose
 * value is a bare string, most of them carrying no path at all. A decoder that only recognises
 * fragment objects keeps the opening character and discards the rest — which is exactly what
 * happened: every answer came back one character long, `finish_reason: stop`, looking like a
 * working model that happened to be terse. "Count from 1 to 10" returned `1`.
 *
 * Two more things the stream requires:
 *
 * **The path is positional, and the last stated one wins.** A thinking model interleaves
 * `THINK` and `RESPONSE` fragments, and an untyped append belongs to whichever was last.
 *
 * **`FINISHED` is a status word, not text.** `{"p":"response/status","v":"FINISHED"}` has a
 * string value, so a decoder that appends every string value writes the literal word `FINISHED`
 * onto the end of the answer. It is consumed as status here, and the absence of it is reported:
 * a body that closes without `FINISHED` was cut off mid-generation, and reporting that as a
 * clean answer is the same fault as not reading the stream at all.
 */
export function decodeDeepSeekAnswer(body: string): { content: string; reasoning: string; finished: boolean; usage: number } {
  let content = '';
  let reasoning = '';
  // Which side an untyped append belongs to, from the last fragment or response that said so.
  let currentPath: 'thinking' | 'content' = 'content';
  let finished = false;
  // The provider reports accumulated token usage in a metadata batch, never as text.
  let usage = 0;

  const append = (text: string) => {
    if (!text) return;
    if (currentPath === 'thinking') reasoning += text;
    else content += text;
  };

  const applyType = (fragment: { type?: unknown }) => {
    const type = String(fragment.type ?? '').toUpperCase();
    if (type === 'THINK') currentPath = 'thinking';
    else if (type === 'ANSWER' || type === 'RESPONSE') currentPath = 'content';
  };

  const takeFragment = (fragment: unknown, pathFromType: boolean) => {
    if (!fragment || typeof fragment !== 'object') return;
    const record = fragment as { type?: unknown; content?: unknown };
    if (pathFromType) applyType(record);
    if (typeof record.content !== 'string' || record.content.length === 0) return;
    if (!pathFromType) applyType(record);
    append(record.content);
  };

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const frame = parsed as { p?: unknown; v?: unknown };
    const path = typeof frame.p === 'string' ? frame.p : '';
    const value = frame.v;

    // Status, not an answer. Checked before the string branch below, deliberately.
    if (path === 'response/status' && value === 'FINISHED') {
      finished = true;
      continue;
    }
    if (path === 'response/search_status' || path === 'response/search_results') continue;

    // A whole response: it declares the path and carries its own fragments.
    if (value && typeof value === 'object' && !Array.isArray(value) && 'response' in (value as Record<string, unknown>)) {
      const response = (value as { response: { thinking_enabled?: unknown; fragments?: unknown; accumulated_token_usage?: unknown } }).response;
      if (response.thinking_enabled === true) currentPath = 'thinking';
      else if (response.thinking_enabled === false) currentPath = 'content';
      if (typeof response.accumulated_token_usage === 'number' && response.accumulated_token_usage > 0) usage = response.accumulated_token_usage;
      if (Array.isArray(response.fragments)) for (const fragment of response.fragments) takeFragment(fragment, false);
    }

    if (path === 'response/fragments') {
      if (Array.isArray(value)) for (const fragment of value) takeFragment(fragment, true);
      else takeFragment(value, true);
      continue;
    }

    // A metadata batch: token counts and status words, never text.
    if (path === 'response' && Array.isArray(value)) {
      for (const entry of value as Array<{ p?: unknown; v?: unknown }>) {
        if (entry?.p === 'response' && (entry.v as { thinking_enabled?: unknown } | undefined)?.thinking_enabled === true) currentPath = 'thinking';
        if (entry?.p === 'accumulated_token_usage' && typeof entry.v === 'number' && entry.v > 0) usage = entry.v;
      }
      continue;
    }

    // Most of a normal answer, and the part that was being dropped.
    if (typeof value === 'string') append(value);
  }
  /**
   * Not trimmed, deliberately.
   *
   * This decoder used to end with `content.trim()` and `reasoning.trim()`, which silently removed
   * the leading and trailing whitespace of every answer. It was the only adapter in the SDK that
   * did this, and the loss is not something a client can detect: an answer that was asked to be
   * exactly `"  indented  "` arrives as `"indented"`, and a code answer loses its trailing
   * newlines, which is visible as badly-indented code rather than as a truncated one.
   *
   * The provider contract's exact-equality assertion is what found it, and it found it because the
   * hostile fixture ends in a single space — a part that looks like nothing and is the whole point.
   */
  return { content, reasoning, finished, usage };
}

/**
 * Reads the whole body, with a cap.
 *
 * The cap is not paranoia about a hostile server so much as about an endless one: a stream
 * that never terminates will grow a buffer until the process is killed, and the failure then
 * reads as an out-of-memory crash rather than as an upstream that never finished.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readBodyCapped(response: Response, signal?: AbortSignal): Promise<string> {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw fail('PROVIDER_REQUEST_FAILED', 'DeepSeek’s answer grew past 8 MB and was cut off.');
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
  return chunks.join('');
}
