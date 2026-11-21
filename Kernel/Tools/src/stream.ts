import type { ToolCallDelta } from './types.js';

/**
 * The streaming half of the contract.
 *
 * A stream cannot be validated the way a response can: the call arrives in pieces, and the arguments are only complete
 * at the end. What *can* be checked immediately is the one thing that matters most — whether the function being called
 * is a tool the client declared. A call to `rm_rf` when the client offered `read` is not a parse problem to fix later;
 * it is a call the client must never see.
 *
 * So this guard passes deltas through while the name is declared, and swallows the deltas of a call whose name is not.
 * Arguments are **not** repaired here: repairing a partial JSON fragment would mean buffering the whole call, and a
 * streaming client that receives its tool call only after the turn ends is a client that thinks the model stalled.
 * Non-streaming requests get the full validation; this one gets the safety.
 */

/**
 * `delta` is an object for every adapter, and a plain string for the ones the server tolerates (and for a scripted
 * test). The first version of this guard spread whatever it found, and spreading a string turns `"twelve chars"` into
 * `{0:"t",1:"w",…}` — the answer vanished, and the usage estimate with it, because the recording path asks
 * `typeof chunk.delta === 'string'`. A chunk whose delta is not an object carries no tool call, so it is passed through
 * untouched.
 */
export type StreamChunk = {
  delta: unknown;
  finishReason?: string;
  [key: string]: unknown;
};

export type StreamGuardReport = {
  /** Calls whose name was declared, and which therefore reached the client. */
  allowed: string[];
  /** Calls whose name was not declared, and whose deltas were dropped. */
  blocked: { index: number; name: string }[];
};

const isObjectDelta = (delta: unknown): delta is { content?: string; toolCalls?: readonly ToolCallDelta[] } =>
  typeof delta === 'object' && delta !== null;

/**
 * Wraps a chunk stream. The report is filled in as the stream is consumed; the caller reads it afterwards.
 */
export function guardToolStream<T extends StreamChunk>(
  chunks: AsyncIterable<T>,
  declared: readonly string[],
  report: StreamGuardReport = { allowed: [], blocked: [] },
  renames: ReadonlyMap<string, string> = new Map(),
): AsyncIterable<T> {
  const allowedNames = new Set(declared);
  const names = new Map<number, string>();
  const blocked = new Set<number>();

  async function* run(): AsyncGenerator<T> {
    for await (const chunk of chunks) {
      const delta = chunk.delta;
      // A chunk with no tool call in it is not this guard's business, and is forwarded byte for byte.
      if (!isObjectDelta(delta)) {
        yield chunk;
        continue;
      }
      const deltas = delta.toolCalls ?? [];
      if (deltas.length === 0) {
        yield chunk;
        continue;
      }

      const kept: ToolCallDelta[] = [];
      for (const piece of deltas) {
        // A name folded to the gateway's canonical spelling is still the caller's tool: check and
        // forward the original name so the agent can recognise its own call.
        const wireName = piece.function?.name;
        const name = wireName ? (renames.get(wireName) ?? wireName) : undefined;
        if (name) names.set(piece.index, name);
        const resolved = names.get(piece.index);
        if (resolved && allowedNames.size > 0 && !allowedNames.has(resolved)) {
          if (!blocked.has(piece.index)) {
            blocked.add(piece.index);
            report.blocked.push({ index: piece.index, name: resolved });
          }
          continue;
        }
        if (blocked.has(piece.index)) continue;
        if (resolved && !report.allowed.includes(resolved)) report.allowed.push(resolved);
        kept.push(name && wireName && name !== wireName ? { ...piece, function: { ...piece.function, name } } : piece);
      }

      // Only a turn with **no** forwarded call stops being a tool-call turn. An earlier chunk may have emitted an
      // allowed call whose name arrived in a different chunk; rewriting this chunk to `stop` then told the client the
      // call it already received never happened, which is the same lie in the other direction.
      const finishReason = chunk.finishReason === 'tool_calls' && report.allowed.length === 0 && blocked.size > 0 && kept.length === 0
        ? 'stop'
        : chunk.finishReason === 'stop' && report.allowed.length > 0
          // Some providers close a tool turn with `stop` despite having streamed a call (Claude Code, Nous). The
          // agent sees a finished turn and never runs the call. Forwarded calls are the ground truth.
          ? 'tool_calls'
          : chunk.finishReason;
      yield {
        ...chunk,
        delta: { ...delta, toolCalls: kept },
        ...(finishReason === chunk.finishReason ? {} : { finishReason }),
      } as T;
    }
  }

  return run();
}
