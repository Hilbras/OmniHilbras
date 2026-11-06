/**
 * Driving a ChatGPT turn through ChatGPT's own code.
 *
 * Typing into the composer does not work. The request is accepted, a placeholder appears,
 * and the page sits at its "Think" indicator forever — the composer path is not how a
 * programmatic client is expected to make a turn, and no amount of waiting changes that.
 *
 * What does work is using the page's *own* request path: the same module it uses to
 * finalise its anti-automation requirements, mint its proof-of-work and Turnstile tokens,
 * build its Sentinel headers, and POST `/f/conversation`. That module is a hashed chunk
 * under `/cdn/assets/`, its exports are minified, and both change on every deployment — so
 * it is found by scanning the page's own asset list for semantic markers and reading the
 * names out of the trailing `export{…}` block, rather than by pinning any of them.
 *
 * Verified against the live page: all four markers are present in one 2.6 MB chunk today.
 * When ChatGPT changes its minified output the markers stop matching, and this fails
 * loudly with that as the reason rather than silently returning nothing.
 *
 * Attachments are not handled. A text-only turn is the whole of what this implements, and
 * saying so is better than a partial upload path.
 */

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHATGPT_ASSET_PATH_RE = /^\/cdn\/assets\/[A-Za-z0-9_-]+\.js$/;
const BRIDGE_KEY = '__omnihilbrasChatGptFirstPartyV1';
const REQUEST_KEY = '__omnihilbrasChatGptRequestV1';
const ABORT_KEY = '__omnihilbrasChatGptAbortV1';

const MAX_DISCOVERY_ASSETS = 256;
const MODULE_DISCOVERY_TIMEOUT_MS = 30_000;
const MODULE_DISCOVERY_POLL_MS = 300;
const ASSET_FETCH_TIMEOUT_MS = 20_000;
const MAX_ASSET_SOURCE_BYTES = 24 * 1024 * 1024;
const MAX_CONVERSATION_RESPONSE_BYTES = 16 * 1024 * 1024;

type Json = Record<string, unknown>;

/** The exports borrowed from ChatGPT's own module, by the name they are exported under. */
export type FirstPartyContract = {
  finalizeRequirements: string;
  proofManager: string;
  turnstileManager: string;
  requestClient: string;
  buildSentinelHeaders: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The minified export name for a local binding.
 *
 * Read from the trailing `export{…}` block rather than from a pinned string, because the
 * short name on the left of an export changes on every build and the semantic marker does
 * not.
 */
function exportedName(source: string, localName: string): string | null {
  const exportStart = source.lastIndexOf('export{');
  if (exportStart < 0) return null;
  const block = source.slice(exportStart + 'export{'.length);
  const match = block.match(new RegExp(`(?:^|,)${escapeRegExp(localName)} as ([A-Za-z_$][\\w$]*)`));
  return match?.[1] ?? null;
}

/**
 * Finds the five things a turn needs, by what they do.
 *
 * These are semantic markers in the minified source, deliberately not pinned identifiers.
 * They are the fragile part of this whole approach and the reason a failure names itself.
 */
export function parseFirstPartyContract(source: string): FirstPartyContract {
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
    throw new Error('ChatGPT changed its request module: none of the required markers were found in any asset.');
  }
  const found = {
    finalizeRequirements: exportedName(source, finalizeLocal),
    proofManager: exportedName(source, proofLocal),
    turnstileManager: exportedName(source, turnstileLocal),
    requestClient: exportedName(source, requestClientLocal),
    buildSentinelHeaders: exportedName(source, headerBuilderLocal),
  };
  if (Object.values(found).some((value) => value === null)) {
    throw new Error('ChatGPT changed its request module: the markers were found but their exports were not.');
  }
  // Non-null by the guard above; the assertion is the compiler being told what it cannot see.
  return found as FirstPartyContract;
}

/**
 * Only a first-party chunk is ever read.
 *
 * The asset list comes off a live page, so it is treated as untrusted input: an origin or a
 * path outside `/cdn/assets/*.js` is refused before anything is fetched from it.
 */
export function requireChatGptAssetUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== CHATGPT_ORIGIN || !CHATGPT_ASSET_PATH_RE.test(url.pathname)) {
    throw new Error('Refusing to load a ChatGPT asset from outside the first-party origin.');
  }
  return url.toString();
}

export function collectAssetCandidates(resourceUrls: readonly string[], modulePreloadUrls: readonly string[]): string[] {
  return Array.from(new Set([...resourceUrls, ...modulePreloadUrls])).filter(
    (url) => url.includes('/cdn/assets/') && url.endsWith('.js'),
  );
}

/** Chunks referenced relatively by a chunk already inspected. */
export function extractAssetReferences(source: string, parentAssetUrl: string): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(/["']\.\/([A-Za-z0-9_-]+\.js)["']/g)) {
    let assetUrl: string;
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

async function readAssetSource(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`ChatGPT asset could not be loaded (${response.status})`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ASSET_SOURCE_BYTES) {
    throw new Error('ChatGPT asset exceeded the size limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_SOURCE_BYTES) throw new Error('ChatGPT asset exceeded the size limit');
  return new TextDecoder().decode(bytes);
}

/** The slice of a Playwright page this module uses, so it can be exercised without one. */
export type PageLike = {
  goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  evaluate: <T>(fn: (arg: never) => T, arg?: unknown) => Promise<T>;
  title: () => Promise<string>;
  locator: (selector: string) => { count: () => Promise<number> };
  url: () => string;
};

const contracts = new Map<string, Promise<FirstPartyContract>>();
let lastKnownAssetUrl: string | null = null;

async function pageCandidates(page: PageLike): Promise<string[]> {
  const sources = await page.evaluate(() => ({
    preloads: Array.from(document.querySelectorAll('link[rel="modulepreload"][href]'), (link) => (link as HTMLLinkElement).href),
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
  }) as { preloads: string[]; resources: string[] });
  return collectAssetCandidates(sources.resources, sources.preloads);
}

/**
 * Scans the page's own assets for the request module.
 *
 * The page loads chunks lazily, so the candidate list is re-read on a poll rather than
 * taken once: the module a turn needs is often not in the first list.
 */
export async function discoverFirstPartyModule(page: PageLike): Promise<{ assetUrl: string; contract: FirstPartyContract }> {
  const queue: string[] = lastKnownAssetUrl ? [lastKnownAssetUrl] : [];
  const visited = new Set<string>();
  let index = 0;
  let lastError: Error | null = null;
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

    let assetUrl: string;
    try {
      assetUrl = requireChatGptAssetUrl(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Invalid ChatGPT asset URL');
      continue;
    }
    try {
      const cached = contracts.get(assetUrl);
      const contract = cached ? await cached : await (async () => {
        const source = await readAssetSource(assetUrl);
        const parsed = parseFirstPartyContract(source);
        // Anything the module references is worth inspecting too, since the contract is
        // sometimes split across two chunks.
        queue.push(...extractAssetReferences(source, assetUrl).filter((ref) => !visited.has(ref)));
        return parsed;
      })();
      contracts.set(assetUrl, Promise.resolve(contract));
      lastKnownAssetUrl = assetUrl;
      return { assetUrl, contract };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('ChatGPT module discovery failed');
    }
  }
  throw new Error(
    `ChatGPT's request module was not found in ${visited.size} asset(s)${lastError ? `: ${lastError.message}` : ''}`,
  );
}

/**
 * Hands ChatGPT's own exports to the rest of this module.
 *
 * The asset is imported **directly** rather than through a generated blob module that
 * re-exports from it. The blob indirection is one more thing that can fail for reasons
 * that have nothing to do with the answer: a blob module importing a cross-origin asset
 * fails with a bare "Failed to fetch dynamically imported module" that says nothing about
 * the cause, while importing the asset itself works and hands over 4000-odd exports. So
 * the five functions are lifted out of the module namespace directly.
 *
 * The names are looked up rather than destructured, so a missing one is named here instead
 * of failing as `undefined is not a function` three calls later.
 */
async function ensureBridge(page: PageLike): Promise<void> {
  const ready = await page.evaluate(
    (key) => {
      const value = (globalThis as never as Json)[key as string];
      return typeof value === 'object' && value !== null;
    },
    BRIDGE_KEY as never,
  );
  if (ready) return;

  const { assetUrl, contract } = await discoverFirstPartyModule(page);
  const installed = await page.evaluate(
    async (args: Record<string, unknown>) => {
      const { bridgeKey, url, names } = args as unknown as { bridgeKey: string; url: string; names: FirstPartyContract };
      const root = globalThis as never as Json;
      if (typeof root[bridgeKey] === 'object' && root[bridgeKey] !== null) return true;
      let module: Json;
      try {
        module = (await import(/* @vite-ignore */ url)) as unknown as Json;
      } catch (error) {
        throw new Error(`ChatGPT's request module could not be imported: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`);
      }
      const missing = Object.entries(names)
        .filter(([, exportName]) => typeof module[exportName] === 'undefined')
        .map(([role]) => role);
      if (missing.length > 0) {
        throw new Error(`ChatGPT's request module does not export ${missing.join(', ')}; its build has changed.`);
      }
      root[bridgeKey] = {
        finalizeRequirements: module[names.finalizeRequirements],
        proofManager: module[names.proofManager],
        turnstileManager: module[names.turnstileManager],
        requestClient: module[names.requestClient],
        buildSentinelHeaders: module[names.buildSentinelHeaders],
      };
      return true;
    },
    { bridgeKey: BRIDGE_KEY, url: assetUrl, names: contract } as never,
  );
  if (!installed) throw new Error('The ChatGPT request module did not install.');
}

/* ------------------------------------------------------------------ *
 * One turn
 * ------------------------------------------------------------------ */

export type FirstPartyTurn = {
  prompt: string;
  /** The model string the page is given, and whether it is asked to think. */
  model: string;
  reason: boolean;
};

/**
 * Makes one turn and returns the raw SSE body.
 *
 * Every step runs inside the page, because every step is ChatGPT's own code: its Sentinel
 * requirements, its proof-of-work and Turnstile tokens, its request client. The
 * alternative — driving the composer — posts a request the page never completes, which is
 * what this replaced.
 */
export async function executeFirstPartyTurn(page: PageLike, turn: FirstPartyTurn): Promise<string> {
  await ensureBridge(page);
  const requestId = globalThis.crypto.randomUUID();

  // 1. The conversation body, exactly as the page would build it for itself.
  await page.evaluate(
    (args: Record<string, unknown>) => {
      const { requestKey, abortKey, id, model, reason, prompt } = args as unknown as {
        requestKey: string; abortKey: string; id: string; model: string; reason: boolean; prompt: string;
      };
      const root = globalThis as never as Json;
      const requests = ((root[requestKey] ??= {}) as Json);
      const aborts = ((root[abortKey] ??= {}) as Json);
      aborts[id] = new AbortController();
      requests[id] = {
        body: {
          action: 'next',
          messages: [
            {
              id: globalThis.crypto.randomUUID(),
              author: { role: 'user' },
              create_time: Date.now() / 1000,
              content: { content_type: 'text', parts: [prompt] },
              // Thinking is asked for with a system hint, not by naming a different model.
              metadata: {
                ...(reason ? { system_hints: ['reason'] } : {}),
                serialization_metadata: { custom_symbol_offsets: [] },
              },
            },
          ],
          parent_message_id: 'client-created-root',
          model,
          timezone_offset_min: new Date().getTimezoneOffset(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          history_and_training_disabled: true,
          conversation_mode: { kind: 'primary_assistant' },
          system_hints: reason ? ['reason'] : [],
          supports_buffering: true,
          supported_encodings: ['v1'],
        },
      };
    },
    { requestKey: REQUEST_KEY, abortKey: ABORT_KEY, id: requestId, model: turn.model, reason: turn.reason, prompt: turn.prompt } as never,
  );

  try {
    // 2. The anti-automation artifacts, minted by ChatGPT's own managers.
    await page.evaluate(
      async (args: Record<string, unknown>) => {
        const { bridgeKey, requestKey, abortKey, id } = args as unknown as { bridgeKey: string; requestKey: string; abortKey: string; id: string };
        const root = globalThis as never as Json;
        const bridge = root[bridgeKey] as {
          finalizeRequirements: (cache?: boolean, source?: string) => Promise<Json>;
          proofManager: { getEnforcementToken: (v: Json, o: Json) => Promise<string> };
          turnstileManager: { getEnforcementToken: (v: Json) => Promise<string> };
          buildSentinelHeaders: (r: Json, t: string, p: string, s: null, o: null, e: null) => Json;
        };
        const draft = (root[requestKey] as Json)[id] as Json;
        const controller = (root[abortKey] as Json)[id] as AbortController;
        const requirements = await bridge.finalizeRequirements(false, 'none');
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const [proof, turnstile] = await Promise.all([
          bridge.proofManager.getEnforcementToken(requirements, { forceSync: true }),
          bridge.turnstileManager.getEnforcementToken(requirements),
        ]);
        draft.additionalHeaders = bridge.buildSentinelHeaders(requirements, turnstile, proof, null, null, null);
      },
      { bridgeKey: BRIDGE_KEY, requestKey: REQUEST_KEY, abortKey: ABORT_KEY, id: requestId } as never,
    );

    // 3. The conversation, and the whole of the answer.
    return (await page.evaluate(
      async (args: Record<string, unknown>) => {
        const { bridgeKey, requestKey, abortKey, id, limit } = args as unknown as { bridgeKey: string; requestKey: string; abortKey: string; id: string; limit: number };
        const root = globalThis as never as Json;
        const client = (root[bridgeKey] as { requestClient: { safePost: (p: string, o: Json) => Promise<unknown> } }).requestClient;
        const draft = (root[requestKey] as Json)[id] as Json;
        const controller = (root[abortKey] as Json)[id] as AbortController;
        const response = await client.safePost('/f/conversation', {
          requestBody: draft.body,
          additionalHeaders: draft.additionalHeaders,
          signal: controller.signal,
          skipJsonTransform: true,
        });
        if (!(response instanceof Response)) throw new Error('The conversation request returned a non-response.');
        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`The conversation request failed with status ${status}.`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('The conversation response was an empty stream.');
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > limit) {
              await reader.cancel().catch(() => undefined);
              throw new Error('The conversation response exceeded the size limit.');
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
      },
      { bridgeKey: BRIDGE_KEY, requestKey: REQUEST_KEY, abortKey: ABORT_KEY, id: requestId, limit: MAX_CONVERSATION_RESPONSE_BYTES } as never,
    )) as string;
  } finally {
    await page
      .evaluate(
        (args: Record<string, unknown>) => {
          const { requestKey, abortKey, id } = args as unknown as { requestKey: string; abortKey: string; id: string };
          const root = globalThis as never as Json;
          delete (root[requestKey] as Json | undefined)?.[id];
          delete (root[abortKey] as Json | undefined)?.[id];
        },
        { requestKey: REQUEST_KEY, abortKey: ABORT_KEY, id: requestId } as never,
      )
      .catch(() => undefined);
  }
}

/**
 * Pulls the assistant's text out of the conversation SSE body.
 *
 * The body is a JSON-patch stream over the conversation document, so the patches are
 * applied to a tree and the last assistant turn is read from the result. Reading the last
 * delta instead would truncate mid-sentence whenever the stream is cut.
 */
export function extractAssistantText(sseBody: string): string {
  /**
   * The stream is JSON Patch, as objects: `{ p, o, v }`.
   *
   * Three shapes matter, and getting any of them wrong reads as an answer that never came:
   *
   *  - `{ v: { message: … } }` with no path — a whole message, appended to the transcript.
   *  - `{ p: "/message/content/parts/0", o: "append", v: "working" }` — **append**, which for
   *    a string means concatenate, not replace. Treating it as a replace keeps only the
   *    final fragment.
   *  - `{ p: "", o: "patch", v: [ …ops ] }` — a batch of the same operations.
   */
  const turns: Json[] = [];

  const applyOperation = (operation: unknown): void => {
    if (typeof operation !== 'object' || operation === null) return;
    const op = operation as { p?: unknown; o?: unknown; v?: unknown };
    const path = typeof op.p === 'string' ? op.p : '';
    const kind = typeof op.o === 'string' ? op.o : 'add';
    const value = op.v;

    if (kind === 'patch' && Array.isArray(value)) {
      for (const nested of value) applyOperation(nested);
      return;
    }

    // A message object with no path is a new turn in the transcript.
    if (path === '' && typeof value === 'object' && value !== null && (value as Json).message) {
      turns.push((value as Json).message as Json);
      return;
    }
    if (turns.length === 0) return;
    const message = turns[turns.length - 1] as Json;
    const parts = path.split('/').filter(Boolean);
    // A patch inside a turn is addressed from the message root.
    const target = parts[0] === 'message' ? parts.slice(1) : parts;
    if (target.length === 0) {
      if (typeof value === 'object' && value !== null) Object.assign(message, value as Json);
      return;
    }

    let node = message as Record<string, unknown>;
    for (const part of target.slice(0, -1)) {
      const child = node[part];
      if (child === null || typeof child !== 'object') {
        node[part] = /^\d+$/.test(target[target.indexOf(part) + 1] ?? '') ? [] : {};
      }
      node = node[part] as Record<string, unknown>;
    }
    const last = target[target.length - 1] as string;
    const previous = node[last];
    if (kind === 'remove') {
      delete node[last];
      return;
    }
    if (kind === 'append') {
      // Append concatenates: a string grows, an array gains an element, an object merges.
      if (typeof previous === 'string' && typeof value === 'string') node[last] = previous + value;
      else if (Array.isArray(previous) && Array.isArray(value)) node[last] = [...previous, ...value];
      else if (previous && typeof previous === 'object' && value && typeof value === 'object') {
        node[last] = { ...(previous as Json), ...(value as Json) };
      } else if (previous === undefined) node[last] = value;
      else if (previous === null || previous === '') node[last] = value;
      else if (Array.isArray(previous)) (previous as unknown[]).push(value);
      else node[last] = value;
      return;
    }
    node[last] = value;
  };

  for (const rawLine of sseBody.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof parsed === 'string') continue;
    applyOperation(parsed);
  }

  // The last assistant message that is prose. A reasoning recap is a different
  // `content_type` and is not the answer, and the user's own turn is not the answer either.
  let lastText = '';
  for (const turn of turns) {
    const author = (turn as Json)?.author as Json | undefined;
    if (author?.role !== 'assistant') continue;
    const content = (turn as Json)?.content as Json | undefined;
    if (content?.content_type !== undefined && content.content_type !== 'text') continue;
    const raw = (content?.parts ?? content?.content) as unknown;
    if (raw === null || raw === undefined) continue;
    const parts: unknown[] = Array.isArray(raw)
      ? (raw as unknown[])
      : typeof raw === 'object'
        ? Object.entries(raw as Json)
            .filter(([key]) => /^\d+$/.test(key))
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([, value]) => value)
        : [];
    const text = parts
      .map((part) => (typeof part === 'string' ? part : ((part as Json)?.content as string | undefined) ?? ((part as Json)?.text as string | undefined) ?? ''))
      .join('')
      .trim();
    if (text) lastText = text;
  }
  return lastText;
}
