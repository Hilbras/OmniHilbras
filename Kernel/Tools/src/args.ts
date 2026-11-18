/**
 * Bounded repair of a tool call's arguments.
 *
 * Providers emit almost-JSON often enough to matter: a trailing comma, single quotes around a key, the object wrapped
 * in a sentence. Forwarding that verbatim is what makes an agent fail three turns later with a parse error it cannot
 * trace; refusing it outright makes a working turn fail.
 *
 * So this repairs a fixed, small set of mistakes and nothing else. There is no evaluator here, no `Function`, no
 * substring search for the first `{` in arbitrary prose — a repair that guesses is a repair that invents arguments for
 * a command that will run.
 */

/** How large an arguments string may be before it is refused rather than repaired. */
export const MAX_ARGUMENTS_BYTES = 64 * 1024;

export type RepairedArguments = {
  /** The JSON text to forward, after repair. Valid JSON when returned. */
  text: string;
  /** What was changed, for the caller's log. Empty when the input was already valid. */
  repairs: readonly string[];
  value: Record<string, unknown>;
};

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Bytes, without `Buffer`.
 *
 * The token saver's guard (`tests/sdk-browser-safety.test.js`) exists because a Node-only API in a library reached a
 * browser bundle once. `TextEncoder` is the same number and exists everywhere this code can run.
 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function stripFence(text: string): { text: string; stripped: boolean } {
  const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(text);
  return fence?.[1] !== undefined ? { text: fence[1].trim(), stripped: true } : { text, stripped: false };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    // `Object.hasOwn`, not `in`: `'constructor' in {}` is true through the prototype chain, so the first version of
    // this refused every object it was given.
    for (const key of RESERVED) if (Object.hasOwn(value as object, key)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Trailing commas before `}` or `]`. The most common single defect, and unambiguous. */
function dropTrailingCommas(text: string): { text: string; changed: boolean } {
  const next = text.replace(/,(\s*[}\]])/g, '$1');
  return { text: next, changed: next !== text };
}

/**
 * Single-quoted keys and single-quoted string values with no apostrophe inside.
 *
 * Deliberately narrow: a double quote or a backslash inside the quoted run means the pattern does not apply, because
 * deciding where an embedded quote belongs is the guessing this refuses to do.
 */
function singleToDoubleQuotes(text: string): { text: string; changed: boolean } {
  const next = text.replace(/'([^'"\\\n]*)'/g, (_match, inner: string) => JSON.stringify(inner));
  return { text: next, changed: next !== text };
}

/** `{key: 1}` — an unquoted key. Only bare identifiers, so a value is never mistaken for one. */
function quoteBareKeys(text: string): { text: string; changed: boolean } {
  const next = text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  return { text: next, changed: next !== text };
}

/**
 * Repair an arguments string, or say why it cannot be.
 *
 * The order matters: each step is applied only if the previous one did not already produce valid JSON, so a string
 * that parses as-is is never rewritten.
 */
export function repairArguments(raw: string): { ok: true; result: RepairedArguments } | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'arguments is not a string' };
  if (utf8Bytes(raw) > MAX_ARGUMENTS_BYTES) {
    return { ok: false, reason: `arguments exceed ${MAX_ARGUMENTS_BYTES} bytes` };
  }
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, result: { text: '{}', repairs: ['empty arguments became {}'], value: {} } };

  const direct = parseObject(trimmed);
  if (direct) return { ok: true, result: { text: trimmed, repairs: [], value: direct } };

  const repairs: string[] = [];
  let candidate = trimmed;
  const fence = stripFence(candidate);
  if (fence.stripped) {
    candidate = fence.text;
    repairs.push('removed a markdown fence');
  }
  for (const [label, step] of [
    ['dropped a trailing comma', dropTrailingCommas],
    ['converted single quotes', singleToDoubleQuotes],
    ['quoted a bare key', quoteBareKeys],
  ] as const) {
    const value = parseObject(candidate);
    if (value) return { ok: true, result: { text: candidate, repairs, value } };
    const applied = step(candidate);
    if (applied.changed) {
      candidate = applied.text;
      repairs.push(label);
    }
  }
  const value = parseObject(candidate);
  if (value) return { ok: true, result: { text: candidate, repairs, value } };
  return { ok: false, reason: 'arguments are not a JSON object, and the bounded repairs did not make one' };
}
