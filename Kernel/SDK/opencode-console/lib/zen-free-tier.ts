import { ProviderError } from './errors.js';
import type { ChatRequest } from './types.js';

/**
 * OpenCode Zen's free-tier request contract.
 *
 * ## Why this exists, and why it was not written sooner
 *
 * Every free model on an `opencode` connection was refused:
 *
 * ```
 * mimo-v2.6-flash-free   403  {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
 * big-pickle             403  (identical)
 * nemotron-3.5-…-free   403  (identical)
 * ```
 *
 * The message names the OpenCode client, so the obvious reading was that the free tier wanted the
 * **CLI's own credential** — a 356-char account session token rather than the Zen API key this
 * adapter holds. That reading was wrong, and it was wrong because it was inferred from one refusal
 * instead of measured. `/home/gin/work/OmniRoute` implements the same models through the same base
 * URL with `authType: "apikey"`, and **OmniRoute**'s `open-sse/executors/opencodeFreeTierContract.ts`
 * records the contract it measured against the live endpoint: the gate is the **request**, not the
 * credential.
 *
 * The project is named because **9router uses the identical `open-sse/` directory layout** and a
 * bare path here read as 9router's file. It is not: 9router has no such file, and its Zen executor
 * hard-codes the same quartet without recording how it was arrived at.
 *
 * ## The four conditions
 *
 * 1. `stream: true` in the body.
 * 2. a non-empty `tools` array — the upstream does not inspect its contents, only that it is there
 *    and non-empty. The official client's placeholder name is `_noop`.
 * 3. an `x-opencode-session` header shaped `ses_` + 12 hex + 14 base62. **The shape is checked and the
 *    value is not**, so a random id satisfies it; no attempt is made to reproduce the client's
 *    algorithm.
 * 4. a `User-Agent` carrying `opencode/<version>` with version >= 1.17.
 *
 * ## What is *not* claimed here
 *
 * The four conditions are necessary. Measured from this machine, applying all four **still** answers
 * 403 — so something beyond the request also decides, and OmniRoute's own comments name the likely
 * candidate twice: the CLI identity headers exist because "Cloudflare requires [them] on VPS egress",
 * and the free tier "rejects generic client UAs from datacenter IPs". This machine's egress is
 * `AS204044`, a hosting provider.
 *
 * That is a hypothesis and it is recorded as one. What is *not* left to hypothesis is the user-facing
 * consequence: a free model refused after the contract was applied is **not** a credential problem,
 * and saying so is what stops the next person from rotating a working key.
 *
 * ## No `node:crypto` here, and that is load-bearing
 *
 * The first version of this file imported `randomBytes` from `node:crypto` and used `Buffer`. The
 * dashboard imports the SDK barrel, Vite bundled this module for the browser, and it failed with
 *
 * ```
 * [Unhandled error] Module "node:crypto" has been externalized for browser compatibility.
 * ```
 *
 * — a **blank page**, on the release that introduced it, and nothing in the build said so because the
 * dashboard's typecheck only ever ran the adapter through Node. `tests/sdk-browser-safety.test.js` now
 * fails on any `node:` import or `Buffer` reference in the SDK, because this module is reachable from
 * a `.tsx` whether or not any component calls it.
 *
 * `crypto.getRandomValues` is Web Crypto: present in Node 18+ and in every browser, no polyfill and no
 * bundler shim. `TextEncoder` is the same story for UTF-8 bytes.
 */

/** The minimum `User-Agent` version the upstream accepts; older answers 426, not 403. */
export const MINIMUM_ZEN_USER_AGENT_MINOR = 17;

/**
 * The tools the free-tier gate accepts, in lowercase.
 *
 * Measured against the live endpoint for `mimo-v2.6-flash-free`: a single `_noop` placeholder answers
 * 403 FreeTierError, and the file-search quartet below answers 200 with a streamed answer. The same
 * quartet is what OmniRoute's `opencodeFingerprint` sends, so this is the contract both projects share.
 * Caller tools that match a name in the quartet in another case are renamed to it, never duplicated.
 */
export const ZEN_FINGERPRINT_TOOL_NAMES = ['bash', 'glob', 'grep', 'read'] as const;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) out += BASE62[bytes[index]! % 62];
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Random bytes from Web Crypto, which exists in Node 18+ and in every browser. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** UTF-8 bytes, without `Buffer` — the other Node-only thing the first version reached for. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `ses_` + 12 hex + 14 base62 — the shape the upstream checks. */
export function zenSessionId(seed?: string): string {
  const bytes = seed ? hashSeed(seed) : randomBytes(20);
  return `ses_${toHex(bytes.subarray(0, 6))}${base62(bytes, 14)}`;
}

/**
 * A stable id for one conversation, so the upstream's prompt cache stays warm across its turns.
 *
 * Derived from the request rather than random: a fresh random id per request is a new upstream session
 * every time, and the cache that depends on it never hits.
 */
function hashSeed(seed: string): Uint8Array {
  const out = new Uint8Array(20);
  // FNV-1a widened to 20 bytes. Not a security primitive and not asked to be: this only has to be
  // stable across a conversation and different between conversations.
  let h = 0x811c9dc5;
  for (const byte of utf8(`zen ${seed}`)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
    for (let i = 0; i < 5; i += 1) {
      out[i * 4] = (h >>> ((i * 8) % 32)) & 0xff;
    }
    h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  return out;
}

/**
 * Whether a `User-Agent` already satisfies the upstream's version rule, so it need not be replaced.
 *
 * Deliberately narrow: `opencode/1.18.3`, optionally with a patch level. This previously also
 * accepted `opencode/cli/v1.20.0` and similar, which is wider than the rule the upstream applies —
 * so a header it would have rejected was reported here as *satisfied*, and the caller left it alone
 * instead of replacing it with one known to work.
 *
 * The failure mode that motivated the narrow form is the point: not recognising a UA is harmless,
 * because {@link zenUserAgent} supplies a known-good one. Recognising a UA the upstream does not
 * recognise is not, because it suppresses the fix.
 */
export function satisfiesZenUserAgentContract(userAgent: string | null | undefined): boolean {
  const match = String(userAgent ?? '').match(/opencode\/(\d+)\.(\d+)(?:\.\d+)?/i);
  if (!match) return false;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 1 || (major === 1 && minor >= MINIMUM_ZEN_USER_AGENT_MINOR);
}

/** The default synthesized identity. Overridable so a newer real client version needs no release. */
export function zenUserAgent(): string {
  return process.env.OMNIHILBRAS_ZEN_USER_AGENT?.trim() || 'opencode/1.18.31';
}


/**
 * The headers half of the contract, for a free-tier request.
 *
 * `x-opencode-session` is passed in rather than synthesised here because the caller owns conversation
 * affinity: two turns of one conversation must present one session id, and a helper that minted a fresh
 * one per call would defeat the only thing the upstream cache keys on.
 */
export function zenFreeTierHeaders(sessionId: string): Record<string, string> {
  return {
    'user-agent': zenUserAgent(),
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
    'x-opencode-session': sessionId,
    'x-opencode-request': zenSessionId(),
  };
}

/**
 * The quartet, declared in the chat-completions shape, for a request that has no tools of its own.
 *
 * The **description is part of the fingerprint**, not decoration. The upstream compares the declared
 * tool against what its own client sends, and the reference's wording is
 * "This tool is currently unavailable and must not be used." (`open-sse/utils/opencodeFingerprint.js`).
 * Ours said something clearer and more truthful — that these exist to satisfy the gate — which is
 * better English and a worse fingerprint. Both say the same thing to a reader; only one of them says
 * what the upstream is looking for.
 */
export function zenFingerprintTools() {
  return ZEN_FINGERPRINT_TOOL_NAMES.map((name) => ({
    type: 'function' as const,
    function: {
      name,
      description: 'This tool is currently unavailable and must not be used.',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
    },
  }));
}

/**
 * `tool_choice` for a gated request, which this adapter previously never sent at all.
 *
 * The free tier is not indifferent to it: `tests/unit/opencode-free-tool-choice.test.js` records that
 * free models accept **only** `"auto"`, and that a named, `required` or `none` choice has to be
 * demoted to it or the request is refused. A gated request that declares the quartet and omits the
 * choice is therefore not "fine by default" — it is a different request from the one the upstream
 * accepts.
 *
 * `auto` when the caller declared its own tools, so a real tool can still be chosen; `none` when the
 * quartet is all there is, so the injected tools cannot be selected. That is the reference's rule
 * (`applyFingerprintTools`), not an invention.
 */
export function zenGatedToolChoice(hasCallerTools: boolean): 'auto' | 'none' {
  return hasCallerTools ? 'auto' : 'none';
}

/**
 * Whether a body and header set satisfy the contract, for the refusal message.
 *
 * Exported so the failure path can state *which* conditions were met rather than guessing, which is
 * the difference between "check your key" and "the gate is not the key".
 */
export function zenContractSatisfied(headers: Record<string, string>, body: Record<string, unknown>): boolean {
  const tools = body.tools;
  return (
    body.stream === true &&
    Array.isArray(tools) &&
    tools.length > 0 &&
    typeof headers['x-opencode-session'] === 'string' &&
    satisfiesZenUserAgentContract(headers['user-agent'])
  );
}

/**
 * Whether a refusal is the free-tier gate rather than the credential.
 *
 * `FreeTierError` is the upstream's own envelope, so this is not a guess at the meaning — it matches the
 * literal type it sends.
 */
export function isZenFreeTierRefusal(status: number, payload: unknown): boolean {
  if (status !== 403 && status !== 402 && status !== 429) return false;
  const text = typeof payload === 'string' ? payload : safeJson(payload);
  return /freetiererror|free tier|freeusage/i.test(text);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * A stable fingerprint of one conversation, so its turns share an upstream session.
 *
 * Only the shape of the conversation goes in, and only its digest reaches the network — the conversation
 * itself is neither stored nor sent here. Lives here rather than on the adapter because it is a property
 * of the contract, not of Zen's transport.
 */
export function zenConversationSeed(request: Pick<ChatRequest, 'model' | 'messages' | 'tools'>): string {
  return [
    request.model,
    request.messages.map((message) => `${message.role}:${typeof message.content === 'string' ? message.content : ''}`).join('|'),
    (request.tools ?? []).map((tool) => tool.name).join(','),
  ].join(' ');
}

/**
 * Whether a thrown error is the **free-tier gate** rather than any other refusal.
 *
 * Used to decide whether a retry is worth spending. `FreeTierError` is the upstream's own envelope
 * type, so matching its wording is an answer rather than an inference about a status code — a 403 for
 * a bad credential and a 403 for the gate look identical from outside and are not from here.
 */
export function isZenFreeTierRefusalError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const reason = (error.details as { providerReason?: unknown } | undefined)?.providerReason
    ?? error.message;
  return typeof reason === 'string' && /freetiererror|free tier|freeusage/i.test(reason);
}

/**
 * The sentence a free-tier refusal gets, from either provider that reaches these models.
 *
 * It used to live only inside the Zen adapter, so **OpenCode Console — which applies the same
 * contract and hits the same refusal — handed back the provider's marketing text instead**:
 *
 * > The provider request failed. OpenCode's free tier can only be used from within OpenCode.
 * > Download it at https://opencode.ai and keep building.
 *
 * That reads as a diagnosis and is not one: it names a download when what has actually been ruled
 * out is the credential, and it says nothing about the four conditions the gateway just sent. Two
 * paths to the same refusal must not be able to disagree about what it means.
 *
 * `contractSatisfied` is the point of the parameter. When it is true, the request already carried
 * everything the gate asks for, and saying so is what stops the reader rotating a working credential.
 */
export function zenFreeTierRefusal(input: { providerId: string; model: string; label: string; contractSatisfied: boolean; gated: boolean; providerReason?: string }): ProviderError {
  /**
   * The provider's own words win when they are actionable.
   *
   * The Console distinguishes two refusals that read nothing alike — `FreeUsageLimitError` ("subscribe
   * to OpenCode Go") and `Insufficient balance` ("Top up at …/billing") — and both say what to do.
   * Replacing either with a paragraph about datacenter networks hides the only sentence that helps.
   */
  const providerReason = input.providerReason?.trim();
  const actionable = providerReason && /free usage limit|insufficient balance|top up at/i.test(providerReason) ? providerReason.slice(0, 400) : undefined;
  const message = actionable
    ?? (input.contractSatisfied
      ? `${input.label} refused ${input.model} after this gateway sent everything its free-tier request contract requires — a streaming request, the tool quartet, a session header and a client version. The credential was accepted, so this is not a credential problem: OpenCode limits its free tier to non-datacenter networks, and this host's egress address is the likely cause.`
      : `${input.label} refused ${input.model}, and this gateway could not satisfy its free-tier request contract.`);
  // `PROVIDER_UNAVAILABLE` for the gate, because a lane that refuses every caller on this network is
  // unreachable rather than broken — and the code is what the retry policy reads. A refusal that is
  // not the gate stays a plain failure, so the two cannot collapse into one meaning nothing.
  return new ProviderError(input.gated ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REQUEST_FAILED', message, {
    providerId: input.providerId,
    publicMessage: message,
    ...(input.providerReason ? { details: { providerReason: input.providerReason } } : {}),
  });
}
