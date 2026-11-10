import type { SavableMessage } from './types.js';

/**
 * Optional external savers.
 *
 * An external compressor is a network hop the request does not depend on. Every failure — no URL, a
 * timeout, a non-2xx response, malformed JSON, messages that do not keep their role order — returns the
 * original conversation and a reason. There is no path where a broken service can drop a turn.
 */

export type ExternalSaverResult = {
  messages: SavableMessage[];
  applied: boolean;
  /** `applied`, `disabled`, `below-threshold`, `unavailable`, `invalid-response`, `phantom-savings`, … */
  reason: string;
  bytesBefore: number;
  bytesAfter: number;
  reportedTokensSaved?: number;
  detail?: string;
};

function bytes(messages: readonly SavableMessage[]): number {
  try {
    return Buffer.byteLength(JSON.stringify(messages), 'utf8');
  } catch {
    return 0;
  }
}

function unchanged(messages: readonly SavableMessage[], reason: string, detail?: string): ExternalSaverResult {
  const size = bytes(messages);
  return { messages: [...messages], applied: false, reason, bytesBefore: size, bytesAfter: size, ...(detail ? { detail } : {}) };
}

/** A response may rewrite content but never reorder, merge or drop turns; the model's conversation is not the proxy's. */
function sameShape(original: readonly SavableMessage[], candidate: unknown): candidate is SavableMessage[] {
  if (!Array.isArray(candidate) || candidate.length !== original.length) return false;
  return candidate.every((message, index) => {
    const expected = original[index];
    return message !== null && typeof message === 'object'
      && (message as { role?: unknown }).role === expected?.role;
  });
}

async function postMessages(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string; detail?: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, reason: 'unavailable', detail: `HTTP ${response.status}` };
    const data = await response.json() as unknown;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'invalid-response', detail: 'response is not an object' };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch (error) {
    return { ok: false, reason: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
}

export type HeadroomOptions = {
  url?: string;
  timeoutMs?: number;
  compressUserMessages?: boolean;
};

/**
 * POST the conversation to a Headroom proxy's `/v1/compress`.
 *
 * A proxy that reports a token delta while the outbound messages shrank by less than 5% is recorded as
 * phantom savings and its result is discarded: the measurement is the wire bytes, not the claim.
 */
export async function headroomCompress(
  messages: readonly SavableMessage[],
  model: string,
  options: HeadroomOptions,
): Promise<ExternalSaverResult> {
  if (!options.url) return unchanged(messages, 'disabled');
  const before = bytes(messages);
  const origin = options.url.replace(/\/$/, '');
  const response = await postMessages(`${origin}/v1/compress`, {
    messages,
    model,
    ...(options.compressUserMessages ? { config: { compress_user_messages: true } } : {}),
  }, options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 3_000);
  if (!response.ok) return unchanged(messages, response.reason, response.detail);
  const candidateRaw = response.data.messages;
  if (!sameShape(messages, candidateRaw)) {
    return unchanged(messages, 'invalid-response', 'messages[] did not preserve turn count and roles');
  }
  const candidate = candidateRaw;
  const after = bytes(candidate);
  const reported = typeof response.data.tokens_saved === 'number' ? response.data.tokens_saved : undefined;
  if (reported && reported > 0 && after >= before * 0.95) {
    return {
      ...unchanged(messages, 'phantom-savings', `reported ${reported} tokens saved while messages shrank <5%`),
      reportedTokensSaved: reported,
    };
  }
  if (after >= before) return { ...unchanged(messages, 'no-shrink'), reportedTokensSaved: reported };
  return {
    messages: candidate,
    applied: true,
    reason: 'applied',
    bytesBefore: before,
    bytesAfter: after,
    ...(reported === undefined ? {} : { reportedTokensSaved: reported }),
  };
}

export type PxpipeOptions = {
  url?: string;
  timeoutMs?: number;
  minChars?: number;
};

/**
 * POST a bulky Anthropic-shaped conversation to a PXPIPE transform endpoint.
 *
 * The endpoint is ours to define because `pxpipe-proxy` is not a dependency: it receives
 * `{messages, model, options}` and must answer `{messages, applied, reason?, imageCount?, imageTokens?}`.
 * The caller restricts this to providers that speak Anthropic, because an imaged conversation is not
 * meaningful to a text-only adapter.
 */
export async function pxpipeCompress(
  messages: readonly SavableMessage[],
  model: string,
  options: PxpipeOptions,
): Promise<ExternalSaverResult> {
  if (!options.url) return unchanged(messages, 'disabled');
  const before = bytes(messages);
  const threshold = options.minChars && options.minChars > 0 ? options.minChars : 25_000;
  if (before < threshold) return unchanged(messages, 'below-threshold');
  const origin = options.url.replace(/\/$/, '');
  const response = await postMessages(`${origin}/v1/transform`, {
    messages,
    model,
    options: { minCompressChars: threshold },
  }, options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 15_000);
  if (!response.ok) return unchanged(messages, response.reason, response.detail);
  if (response.data.applied === false) {
    return unchanged(messages, typeof response.data.reason === 'string' ? response.data.reason : 'passthrough');
  }
  const candidateRaw = response.data.messages;
  if (!sameShape(messages, candidateRaw)) {
    return unchanged(messages, 'invalid-response', 'messages[] did not preserve turn count and roles');
  }
  const candidate = candidateRaw;
  const after = bytes(candidate);
  const imageTokens = typeof response.data.imageTokens === 'number' ? response.data.imageTokens : 0;
  const imageCount = typeof response.data.imageCount === 'number' ? response.data.imageCount : 0;
  return {
    messages: candidate,
    applied: true,
    reason: 'applied',
    bytesBefore: before,
    bytesAfter: after,
    ...(imageCount ? { detail: `${imageCount} image(s), ~${imageTokens} image tokens` } : {}),
  };
}
