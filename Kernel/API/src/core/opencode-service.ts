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

/** One delta as the service reports it: text, reasoning, or both. */
export type OpencodeServiceDelta = { text?: string; reasoning?: string };

export type OpencodeServiceStreamOptions = {
  keepSession?: boolean;
  fetch?: FetchLike;
  /** Called for every delta the service publishes, while the turn runs. */
  onDelta?: (delta: OpencodeServiceDelta) => void;
  /** How long a silent event stream is tolerated before the turn is abandoned. */
  idleTimeoutMs?: number;
  /**
   * The session's ruleset. `undefined` means "decide from the environment", `null` means "send none"
   * (the agent's own `*: allow`), and an array is used as given.
   */
  permissions?: Array<{ action: string; resource: string; effect: string }> | null;
};

type ByteReader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };

async function readWithIdle(reader: ByteReader, idleMs: number): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: NodeJS.Timeout | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The OpenCode service went quiet for ${Math.round(idleMs / 1000)}s.`)), idleMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads the assistant message out of the session's stored record.
 *
 * The event stream is the live view; this is the record. It supplies `model` and `finish`, and it
 * fills anything the stream did not carry — a delta published before the subscription attached.
 */
async function readAssistant(
  callHere: (path: string, init: { method: string; body?: unknown; signal?: AbortSignal; expectNoContent?: boolean }) => Promise<Json>,
  sessionID: string,
  signal: AbortSignal,
): Promise<OpencodeServiceTurnResult | undefined> {
  const listed = await callHere(`/api/session/${encodeURIComponent(sessionID)}/message`, { method: 'GET', signal });
  const messages = Array.isArray((listed as { data?: unknown }).data) ? ((listed as { data: unknown[] }).data) : [];
  const assistant = [...messages].reverse().find((entry) => (entry as { type?: unknown })?.type === 'assistant') as
    | { content?: Array<{ type?: string; text?: string; thinking?: string }>; model?: { id?: string }; finish?: string }
    | undefined;
  if (!assistant) return undefined;
  const content = Array.isArray(assistant.content) ? assistant.content : [];
  const text = content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('');
  const reasoning = content
    .filter((part) => part?.type === 'reasoning' || part?.type === 'thinking')
    .map((part) => part.text ?? part.thinking ?? '')
    .join('');
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(assistant.model?.id ? { model: assistant.model.id } : {}),
    ...(assistant.finish ? { finish: assistant.finish } : {}),
  };
}

/**
 * Runs one turn through the local service, reporting deltas as they arrive.
 *
 * ## Why the event stream, and not `/wait`
 *
 * `/wait` answers when the session goes idle — the whole turn in one response. A client saw nothing
 * for two to three minutes, its 120 s first-byte deadline fired, and the failure read `504 The
 * provider request timed out.` — with no streaming and no thinking, because both only existed once
 * the turn was already over.
 *
 * The service publishes a per-turn event stream (`GET /api/event`, SSE) whose events carry the
 * deltas directly. Measured live on a free model:
 *
 * ```
 * session.reasoning.delta   {sessionID, assistantMessageID, ordinal, delta}
 * session.text.delta        {sessionID, assistantMessageID, ordinal, delta}
 * session.text.ended        {sessionID, assistantMessageID, ordinal, text}
 * session.usage.updated     {sessionID, cost, tokens:{input, output, reasoning, cache}}
 * session.execution.succeeded | session.execution.failed   {sessionID}
 * ```
 *
 * Subscribing **before** the prompt is what makes this complete: a delta published between "prompt
 * accepted" and "stream attached" would otherwise be lost. The stored message is still read at the
 * end, because it is the record and supplies `model` and `finish`.
 *
 * The session is deleted afterwards unless the caller asked to keep it: a gateway turn is
 * stateless, and leaving a session per request would grow the service's database without bound.
 */
/** The tool actions a chat bridge must not hand the model. */
const UNSAFE_TOOL_ACTIONS = ['shell', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'task', 'subagent', 'browser'] as const;

/**
 * The only tools a chat bridge keeps, and everything else — including tools this code has never seen —
 * is denied by the `*` rule above them.
 */
const READ_ONLY_TOOL_ACTIONS = ['read', 'grep', 'glob'] as const;

/**
 * What the session the gateway creates is allowed to do.
 *
 * ## Deny everything, then allow the two read-only tools back
 *
 * The first version listed the tools to deny — `shell`, `edit`, `write`, `patch`, `webfetch`,
 * `websearch`, `task`, `subagent`, `browser` — which is a list that goes stale the moment the client
 * ships another tool: `question`, `external_directory`, a to-do tool, a goal tool. A deny list is a
 * promise to keep enumerating someone else's surface.
 *
 * The rules are ordered, and a later rule wins, so this is an allow list by construction: `*` denied,
 * then `read`, `grep` and `glob` allowed back. A tool this code has never heard of is denied without
 * anyone updating anything.
 *
 * ## Why this exists — measured, not assumed
 *
 * A session created by this bridge is an **agent** session, not a completion: it inherits OpenCode's
 * `build` agent, whose ruleset is `*: allow`. A prompt saying "list the files in the current directory
 * using a tool" did exactly that — the service emitted four `session.tool.*` events and the answer
 * began `Contents of \`/home/gin\` (108 entries)`. A chat-completions request from the dashboard, an
 * agent, or anything else holding a gateway key could therefore read files and run commands on the
 * operator's machine and send the result to the provider.
 *
 * The read-only tools stay so a coding agent can answer about a file it was handed. That exposure is
 * real and is stated in `docs/SPEC-SDK.md`: a model that can read can read anything the gateway user
 * can. `OMNIHILBRAS_OPENCODE_SERVICE_TOOLS=all` restores the agent's own ruleset, and it is opt-in.
 */
export function opencodeServicePermissions(env: Readonly<Record<string, string | undefined>> = process.env): Array<{ action: string; resource: string; effect: string }> | undefined {
  if ((env.OMNIHILBRAS_OPENCODE_SERVICE_TOOLS ?? '').trim().toLowerCase() === 'all') return undefined;
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...READ_ONLY_TOOL_ACTIONS.map((action) => ({ action, resource: '*', effect: 'allow' })),
  ];
}

export async function streamOpencodeServiceTurn(
  endpoint: OpencodeServiceEndpoint,
  input: OpencodeServiceTurnInput,
  options: OpencodeServiceStreamOptions = {},
): Promise<OpencodeServiceTurnResult> {
  const fetchImpl = options.fetch ?? fetch;
  const callHere = (path: string, init: { method: string; body?: unknown; signal?: AbortSignal; expectNoContent?: boolean }) => call(endpoint, path, init, fetchImpl);
  const ref = parseModelRef(input.model);
  if (!ref) throw new Error(`"${input.model}" is not a provider/model reference.`);

  const created = await callHere('/api/session', {
    method: 'POST',
    body: {
      model: ref,
      ...(options.permissions === undefined ? { permissions: opencodeServicePermissions() } : options.permissions ? { permissions: options.permissions } : {}),
      ...(input.directory ? { location: { directory: input.directory } } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const sessionID = ((created.data ?? {}) as { id?: unknown }).id;
  if (typeof sessionID !== 'string' || !sessionID) throw new Error('The local OpenCode service created no session.');

  const abort = new AbortController();
  const relay = () => abort.abort(input.signal?.reason);
  if (input.signal) {
    if (input.signal.aborted) abort.abort(input.signal.reason);
    else input.signal.addEventListener('abort', relay, { once: true });
  }
  const signal = abort.signal;
  let cancelStream: (() => void) | undefined;

  try {
    const events = await fetchImpl(`${endpoint.url}/api/event`, {
      method: 'GET',
      headers: { authorization: basicAuth(endpoint.password), accept: 'text/event-stream' },
      signal,
    });
    if (!events.ok || !events.body) throw new Error(`The local OpenCode service refused GET /api/event: HTTP ${events.status}`);
    const chunks = events.body.getReader() as ByteReader;
    cancelStream = () => { void (events.body as ReadableStream<Uint8Array>).cancel().catch(() => undefined); };

    await callHere(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: 'POST',
      body: { text: input.text },
      signal,
    });

    const decoder = new TextDecoder();
    const idleMs = options.idleTimeoutMs ?? 300_000;
    let buffer = '';
    let text = '';
    let reasoning = '';
    /**
     * Whether the answer has started.
     *
     * A session is an agent loop, so one turn can be several steps, and each step emits its own
     * reasoning and text parts. Forwarded in arrival order that reads as *thinking, answer, thinking,
     * and then the answer continues in the first block* — because `content` is one string while a
     * client opens a new thinking block wherever a reasoning delta lands. Measured on a live turn:
     * `reasoning.delta` … `text.started` … `text.delta` ×18 … **`reasoning.ended`** — the parts are
     * concurrent, and their end events do not follow their deltas.
     *
     * So reasoning is forwarded only until the first text delta: one thinking block, then the answer,
     * which is what a client that shows `reasoning_content` expects. Reasoning produced after the
     * answer started is still accumulated and still returned in the non-streaming result; it is not
     * spliced into the middle of the answer.
     */
    let contentStarted = false;
    let failure: string | undefined;
    let finished = false;

    while (!finished) {
      const chunk = await readWithIdle(chunks, idleMs);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (!payload) continue;
        let event: { type?: string; data?: Record<string, unknown> } | undefined;
        try {
          event = JSON.parse(payload) as { type?: string; data?: Record<string, unknown> };
        } catch {
          continue;
        }
        const data = event?.data ?? {};
        // Every event carries a sessionID except the process-wide ones; another turn's output is not
        // this turn's answer.
        if (data.sessionID !== sessionID) continue;
        if (event?.type === 'session.text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (!delta) continue;
          text += delta;
          contentStarted = true;
          options.onDelta?.({ text: delta });
          continue;
        }
        if (event?.type === 'session.reasoning.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (!delta) continue;
          reasoning += delta;
          // One thinking block, then the answer — see `contentStarted` above.
          if (!contentStarted) options.onDelta?.({ reasoning: delta });
          continue;
        }
        if (event?.type === 'session.execution.succeeded' || event?.type === 'session.idle') {
          finished = true;
          break;
        }
        if (event?.type === 'session.execution.failed') {
          // The service sends `error` as an object (`{type, message}`) on a provider failure and as a
          // string in some paths; a bare sentence here would hide the one thing worth reading.
          const detail = data.error;
          failure = typeof detail === 'string'
            ? detail
            : typeof (detail as { message?: unknown } | undefined)?.message === 'string'
              ? String((detail as { message: string }).message)
              : 'The OpenCode service failed the turn.';
          finished = true;
          break;
        }
      }
    }

    if (failure) throw new Error(failure);

    const stored = await readAssistant(callHere, sessionID, signal).catch(() => undefined);
    const finalText = stored?.text || text;
    const finalReasoning = stored?.reasoning || reasoning;
    return {
      text: finalText,
      ...(finalReasoning ? { reasoning: finalReasoning } : {}),
      ...(stored?.model ? { model: stored.model } : {}),
      ...(stored?.finish ? { finish: stored.finish } : {}),
    };
  } finally {
    cancelStream?.();
    abort.abort();
    input.signal?.removeEventListener('abort', relay);
    if (!options.keepSession) {
      await callHere(`/api/session/${encodeURIComponent(sessionID)}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
}

/**
 * Runs one turn and returns the answer once it is complete.
 *
 * The stream is what makes the answer arrive at all — see `streamOpencodeServiceTurn`. A caller that
 * does not want the deltas just does not supply `onDelta`.
 */
export async function runOpencodeServiceTurn(
  endpoint: OpencodeServiceEndpoint,
  input: OpencodeServiceTurnInput,
  options: OpencodeServiceStreamOptions = {},
): Promise<OpencodeServiceTurnResult> {
  return streamOpencodeServiceTurn(endpoint, input, options);
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
  /**
   * The same turn, reporting deltas while it runs.
   *
   * Without this the answer arrived in one piece after the whole turn — two to three minutes for a
   * free model — and a client's first-byte deadline fired first, so it saw `504` and never saw the
   * thinking at all.
   */
  stream?(input: {
    model: string;
    text: string;
    signal?: AbortSignal;
    onDelta: (delta: OpencodeServiceDelta) => void;
  }): Promise<{ text: string; reasoning?: string; finish?: string; model?: string }>;
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
  const resolve = async () => {
    endpoint ??= await discoverOpencodeService(options);
    if (!endpoint) {
      throw new OpencodeServiceUnavailableError('The OpenCode app is not running on this machine, and its free tier is only served through it. Start OpenCode and try again.');
    }
    return endpoint;
  };
  const finish = (result: OpencodeServiceTurnResult) => ({
    text: result.text,
    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    ...(result.finish ? { finish: result.finish } : {}),
    ...(result.model ? { model: result.model } : {}),
  });
  return {
    async turn({ model, text, signal }) {
      const found = await resolve();
      return finish(await streamOpencodeServiceTurn(found, {
        model,
        text,
        ...(options.directory ? { directory: options.directory } : {}),
        ...(signal ? { signal } : {}),
      }, { permissions: opencodeServicePermissions(options.env) }));
    },
    async stream({ model, text, signal, onDelta }) {
      const found = await resolve();
      return finish(await streamOpencodeServiceTurn(found, {
        model,
        text,
        ...(options.directory ? { directory: options.directory } : {}),
        ...(signal ? { signal } : {}),
      }, { onDelta, permissions: opencodeServicePermissions(options.env) }));
    },
  };
}
