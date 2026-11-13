import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The OpenCode **local service** — the transport the desktop app and CLI use.
 *
 * ## Why this exists
 *
 * OpenCode's free tier answers `429 FreeUsageLimitError` to a direct request from this machine, with
 * the account's own credential and the client's own headers, from Node **and** from Bun — while
 * `opencode run --model opencode/deepseek-v4.1-flash-free` succeeds seconds later. The service the app
 * talks to is what qualifies, so a gateway that wants those models has to go through it.
 *
 * ## What the service is (observed)
 *
 * - It registers itself in the XDG state directory: `{id, version, url, pid, password}`.
 * - Auth is **HTTP Basic** with username `opencode` and that password
 *   (`opencode:<password>` → 200/404; anything else, including `Bearer <password>`, → `401`).
 * - It has no OpenAI-compatible chat endpoint. A turn is a **session**:
 *   `POST /api/session {model:{id,providerID}}` → `POST /api/session/:id/prompt {text}`
 *   → `POST /api/experimental/session/:id/wait` (204 when idle)
 *   → `GET /api/session/:id/message` → the assistant message's `content[]`.
 *
 * Verified live: that flow returned `content:[{"type":"text","text":"OK"}]`, `finish:"stop"`,
 * `cost:0` for `opencode/deepseek-v4.1-flash-free`.
 *
 * ## Boundary
 *
 * This makes the provider depend on OpenCode being installed and running. It is opt-in, discovered
 * from the registration file, and never spawned by the gateway.
 */

export type OpencodeServiceEndpoint = {
  url: string;
  password: string;
  version?: string;
  pid?: number;
};

export type OpencodeServiceTurnInput = {
  /** `provider/model`, e.g. `opencode/deepseek-v4.1-flash-free`. */
  model: string;
  /** The conversation, flattened into one prompt — the service takes `text`. */
  text: string;
  directory?: string;
  signal?: AbortSignal;
};

export type OpencodeServiceTurnResult = {
  text: string;
  reasoning?: string;
  model?: string;
  finish?: string;
};

const BASIC_USER = 'opencode';

export function defaultOpencodeServiceFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(stateHome, 'opencode', 'service.json');
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`${BASIC_USER}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Reads the registration file.
 *
 * Returns `undefined` rather than throwing when there is none: "OpenCode is not running here" is a
 * normal state, not an error, and the caller falls back to the direct lane.
 */
export async function discoverOpencodeService(
  options: { file?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<OpencodeServiceEndpoint | undefined> {
  const file = options.file ?? defaultOpencodeServiceFile(options.env);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as { url?: unknown; password?: unknown; version?: unknown; pid?: unknown };
  if (typeof record.url !== 'string' || typeof record.password !== 'string') return undefined;
  const url = record.url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(url) && !/^https?:\/\/localhost:\d+$/.test(url)) return undefined;
  return {
    url,
    password: record.password,
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
  };
}

type Json = Record<string, unknown>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function call(endpoint: OpencodeServiceEndpoint, path: string, init: { method: string; body?: unknown; signal?: AbortSignal; expectNoContent?: boolean }, fetchImpl: FetchLike = fetch): Promise<Json> {
  const response = await fetchImpl(`${endpoint.url}${path}`, {
    method: init.method,
    headers: {
      authorization: basicAuth(endpoint.password),
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (init.expectNoContent && response.status === 204) return {};
  const payload = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`The local OpenCode service refused ${init.method} ${path}: ${message}`);
  }
  return payload;
}

/** Splits `provider/model#variant` the way the service's model reference expects. */
export function parseModelRef(model: string): { providerID: string; id: string; variant?: string } | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0) return undefined;
  const providerID = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  const hash = rest.indexOf('#');
  const id = hash === -1 ? rest : rest.slice(0, hash);
  if (!id) return undefined;
  return { providerID, id, ...(hash === -1 ? {} : { variant: rest.slice(hash + 1) }) };
}

/**
 * Runs one turn through the local service and returns the assistant's text.
 *
 * The session is deleted afterwards unless the caller asked to keep it: a gateway turn is stateless,
 * and leaving a session per request would grow the service's database without bound.
 */
export async function runOpencodeServiceTurn(
  endpoint: OpencodeServiceEndpoint,
  input: OpencodeServiceTurnInput,
  options: { keepSession?: boolean; fetch?: FetchLike } = {},
): Promise<OpencodeServiceTurnResult> {
  const fetchImpl = options.fetch ?? fetch;
  const callHere = (path: string, init: { method: string; body?: unknown; signal?: AbortSignal; expectNoContent?: boolean }) => call(endpoint, path, init, fetchImpl);
  const ref = parseModelRef(input.model);
  if (!ref) throw new Error(`"${input.model}" is not a provider/model reference.`);

  const created = await callHere('/api/session', {
    method: 'POST',
    body: { model: ref, ...(input.directory ? { location: { directory: input.directory } } : {}) },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const sessionID = ((created.data ?? {}) as { id?: unknown }).id;
  if (typeof sessionID !== 'string' || !sessionID) throw new Error('The local OpenCode service created no session.');

  try {
    await callHere(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: 'POST',
      body: { text: input.text },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await callHere(`/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {
      method: 'POST',
      expectNoContent: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const listed = await callHere(`/api/session/${encodeURIComponent(sessionID)}/message`, {
      method: 'GET',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const messages = Array.isArray((listed as { data?: unknown }).data) ? ((listed as { data: unknown[] }).data) : [];
    const assistant = [...messages].reverse().find((entry) => (entry as { type?: unknown })?.type === 'assistant') as
      | { content?: Array<{ type?: string; text?: string; thinking?: string }>; model?: { id?: string }; finish?: string }
      | undefined;
    if (!assistant) throw new Error('The local OpenCode service returned no assistant message.');
    const content = Array.isArray(assistant.content) ? assistant.content : [];
    const text = content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
    const reasoning = content.filter((part) => part?.type === 'reasoning' || part?.type === 'thinking').map((part) => part.text ?? part.thinking ?? '').join('');
    return {
      text,
      ...(reasoning ? { reasoning } : {}),
      ...(assistant.model?.id ? { model: assistant.model.id } : {}),
      ...(assistant.finish ? { finish: assistant.finish } : {}),
    };
  } finally {
    if (!options.keepSession) {
      await callHere(`/api/session/${encodeURIComponent(sessionID)}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}

/**
 * Flattens a chat request into the single prompt the service takes.
 *
 * The service is an agent session, not a completion endpoint, so the roles have to survive as text.
 * This mirrors what the reference bridges do; it is the honest limit of driving a session API.
 */
export function flattenMessagesForService(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (part as { text?: string })?.text ?? '').join('')
        : '';
    if (!text.trim()) continue;
    const label = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : message.role === 'tool' ? 'Tool' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n') || randomUUID();
}
/**
 * The shape the SDK adapter consumes.
 *
 * It lives here rather than in the SDK because discovery reads the filesystem, and the SDK is bundled
 * into the browser dashboard where `node:fs` does not exist.
 */
export type OpencodeLocalService = {
  turn(input: { model: string; text: string; signal?: AbortSignal }): Promise<{ text: string; reasoning?: string; finish?: string; model?: string }>;
};

/** Thrown when OpenCode is not running here. The adapter falls back to the direct lane on this name. */
export class OpencodeServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpencodeServiceUnavailable';
  }
}

/**
 * Builds the adapter-facing bridge.
 *
 * Discovery is retried on every call while it fails, so starting OpenCode after the gateway does not
 * require a restart; once found, the endpoint is reused because the registration file is stable.
 */
export function createOpencodeLocalService(options: { file?: string; env?: Readonly<Record<string, string | undefined>>; directory?: string } = {}): OpencodeLocalService {
  let endpoint: OpencodeServiceEndpoint | undefined;
  return {
    async turn({ model, text, signal }) {
      endpoint ??= await discoverOpencodeService(options);
      if (!endpoint) {
        throw new OpencodeServiceUnavailableError('The OpenCode app is not running on this machine, and its free tier is only served through it. Start OpenCode and try again.');
      }
      const result = await runOpencodeServiceTurn(endpoint, {
        model,
        text,
        ...(options.directory ? { directory: options.directory } : {}),
        ...(signal ? { signal } : {}),
      });
      return {
        text: result.text,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.finish ? { finish: result.finish } : {}),
        ...(result.model ? { model: result.model } : {}),
      };
    },
  };
}
