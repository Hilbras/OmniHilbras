/**
 * A transport that answers from a script instead of a network.
 *
 * Every provider contract test drives its adapter through this, which is why the suite can be
 * uniform while each provider still owns its own wire shape: the harness knows about HTTP, and
 * nothing else.
 *
 * It implements `HttpTransport` — `{ request, stream }` returning already-parsed data — and not
 * `fetch`. That distinction is not pedantry: the first version of this harness returned a
 * `Response`, so every adapter read `undefined` and every execution assertion failed with an
 * `INVALID_RESPONSE` that looked like a provider bug. A test double that does not implement the
 * interface it is standing in for produces failures that are indistinguishable from real ones,
 * which makes it worse than no double at all.
 *
 * The refusal is modelled the way real providers actually behave, which is not what their
 * documentation implies. Some answer a refusal with HTTP 401 and some with **HTTP 200 and a
 * refusal in the body** — Qwen does both — so `refuseWith: { status, body }` covers the first and
 * `refuseWith: { status: 200, body: { ret: ['FAIL_…'] } }` the second. A harness that could only
 * express the first would have hidden that whole class.
 */
import { ProviderError } from '../../dist/errors.js';

/**
 * The same status-to-code mapping the real transport applies, so a refusal reaches the adapter
 * classified exactly as it would be in production.
 *
 * Duplicated rather than imported on purpose: a test double that shares the implementation it is
 * meant to stand in for cannot catch a bug in that implementation, and this mapping is load
 * bearing — the routing engine ejects connections based on it.
 */
function codeForStatus(status) {
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'PROVIDER_TIMEOUT';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_REQUEST_FAILED';
}

function refusal(status, body, providerId) {
  return new ProviderError(codeForStatus(status), `The provider answered HTTP ${status}.`, {
    providerId,
    statusCode: status,
    publicMessage: `The provider answered HTTP ${status}.`,
    ...(body === undefined ? {} : { details: body }),
  });
}

export function scriptedTransport({ wireFormat = 'openai' } = {}) {
  const state = { mode: 'ok', parts: [], status: 200, body: undefined };
  const seen = [];
  const errors = [];

  const transport = {
    /** Everything the adapter asked for, for assertions about the wire. */
    seen,
    /** Set by a test to model a refusal that the transport itself must not treat as one. */
    /**
     * `refuseWith` accepts a bare status or a full shape.
     *
     * `{ refuseWith: 401 }` is the obvious thing to write, and reading only `.status` off it
     * yields `undefined` and then **200** — so a refusal test silently asserted that a refusal
     * works, and the provider "passed". A harness that fails open on the most likely call is
     * worse than one that refuses to guess.
     */
    set(parts, options = {}) {
      const refusal = options.refuseWith;
      const shaped = typeof refusal === 'number' ? { status: refusal } : (refusal ?? undefined);
      state.mode = shaped === undefined ? 'ok' : 'refuse';
      state.parts = parts;
      state.status = shaped?.status ?? 200;
      state.body = shaped?.body;
    },
    async request(request) {
      seen.push({ url: request.url, method: request.method, headers: request.headers, body: request.body });
      if (state.mode === 'refuse' && state.status >= 400) {
        // A real transport classifies a non-2xx and throws a ProviderError. The contract asserts
        // on what the adapter does with that, so the throw is what has to happen here.
        throw refusal(state.status, state.body, providerIdFor(request));
      }
      if (state.mode === 'refuse') {
        // A 200 that carries a refusal in the body. The transport passes it through untouched, so
        // the adapter is the one that has to notice — and on some providers it does not, which is
        // exactly why the contract tests this shape rather than assuming it away.
        return { status: state.status, headers: new Headers({ 'content-type': 'application/json' }), data: state.body ?? {} };
      }
      // A non-streaming request gets a complete JSON completion. Serving SSE here made every
      // `chat` assertion fail with "returned no choices", which reads as a provider bug and is
      // entirely the harness's fault.
      // Kiro is not JSON at all: its frames are a length-prefixed binary envelope, and the
      // adapter reads them with a DataView. A harness that returned parsed JSON could not have
      // exercised it, and pretending otherwise would be a pass that proved nothing.
      if (request.responseAs === 'bytes') {
        return { status: state.status, headers: new Headers(), data: binaryFrames(state.parts) };
      }
      const data = isModelsRequest(request) || isConsoleConfigRequest(request) ? modelsPayload(wireFormat) : completionPayload(wireFormat, state.parts);
      return { status: state.status, headers: new Headers({ 'content-type': 'application/json' }), data };
    },
    async *stream(request) {
      seen.push({ url: request.url, method: request.method, headers: request.headers, body: request.body });
      if (state.mode === 'refuse' && state.status >= 400) throw refusal(state.status, state.body, providerIdFor(request));
      for (const piece of framesFor(request, state.parts, wireFormat)) yield piece;
    },
  };
  return transport;
}

/**
 * Whether this is the catalog endpoint.
 *
 * The naive `/models` test also matched Gemini's generateContent URLs, because those embed the
 * model name in the path (`/v1beta/models/<name>:generateContent`). The harness then answered a
 * chat with a model list, and the adapter reported "missing a candidate" — a failure that named
 * the provider and was entirely the harness's fault.
 */
function isModelsRequest(request) {
  return /\/models\b/.test(request.url) && !/:(generateContent|streamGenerateContent|countTokens)/.test(request.url);
}

/**
 * Whether this is the console's config read.
 *
 * OpenCode Console resolves an org *before* it will list its lanes — `/api/config` answers
 * `400 {"code":"org_required"}` without one — so a harness that only knew about `/models` left
 * the adapter looking for a lane it had never been told about.
 */
function isConsoleConfigRequest(request) {
  return /\/api\/config\b/.test(request.url);
}

function contentTypeFor(request) {
  return isModelsRequest(request) ? 'application/json' : 'text/event-stream';
}

/** The provider id a URL belongs to, for the error's attribution. */
function providerIdFor() {
  return 'contract';
}

function modelsPayload(wireFormat) {
  if (wireFormat === 'console') {
    /**
     * OpenCode Console does not publish a model list — it publishes a *routing table*, mapping
     * each model to the lane that serves it. An adapter that cannot find a lane refuses the
     * model by name, so an OpenAI-shaped catalog answers a question nobody asked and the
     * refusal looks like a bug in the adapter rather than in the fixture.
     */
    return {
      config: {
        provider: {
          opencode: {
            api: 'https://lane.invalid/v1',
            models: { 'contract-model': { provider: { api: 'https://lane.invalid/v1' } } },
          },
        },
      },
    };
  }
  if (wireFormat === 'console') {
    return { config: { provider: { opencode: { api: 'https://lane.invalid/v1', models: { 'contract-model': { provider: { api: 'https://lane.invalid/v1' } } } } } } };
  }
  if (wireFormat === 'gemini') {
    // Gemini requires the method it claims, and the adapter filters on it — so a fixture that
    // omits it returns an empty catalog and the attribution assertion fails for the wrong reason.
    return { models: [{ name: 'models/contract-model', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'], inputTokenLimit: 1024 }] };
  }
  return { object: 'list', data: [{ id: 'contract-model', object: 'model', owned_by: 'contract' }] };
}

/**
 * A complete non-streaming completion, assembled from the parts.
 *
 * Assembled rather than returned whole on purpose: the assertion is that the adapter reconstructs
 * the text, and handing it a pre-joined string would test nothing about the adapter at all.
 */
function completionPayload(wireFormat, parts) {
  if (wireFormat === 'anthropic') {
    // Anthropic returns content as a list of typed blocks, not a string.
    return { id: 'contract', type: 'message', role: 'assistant', model: 'contract-model', content: [{ type: 'text', text: parts.join('') }], stop_reason: 'end_turn' };
  }
  if (wireFormat === 'gemini') {
    // Gemini nests the text under candidates → content → parts, and each part is separate. The
    // list is the point: a reader that only takes the first part is the exact failure mode this
    // suite exists to catch, and a single joined part would hide it.
    return { candidates: [{ content: { role: 'model', parts: parts.map((text) => ({ text })) }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: parts.length, totalTokenCount: parts.length + 1 } };
  }
  return {
    id: 'contract',
    object: 'chat.completion',
    created: 0,
    model: 'contract-model',
    choices: [{ index: 0, message: { role: 'assistant', content: parts.join('') }, finish_reason: 'stop' }],
  };
}

/**
 * A body in whichever shape the endpoint implies.
 *
 * Both the OpenAI and the Anthropic style are emitted, chosen by what the request looks like, so
 * one harness serves adapters that speak very different wire formats. The parts are emitted as
 * **separate** frames rather than one joined string, because a joined fixture cannot detect a
 * decoder that drops everything after the first frame — the failure this whole suite exists for.
 */
function scriptedBodyFor(request, parts) {
  if (isModelsRequest(request)) return JSON.stringify(modelsPayload('openai'));
  return framesFor(request, parts, 'openai').join('');
}

/** Gemini's stream is SSE too, but every frame carries the whole candidate shape. */
function geminiFrames(parts) {
  const frames = parts.map(
    (text) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] })}\n\n`,
  );
  // Gemini carries the finish on a final candidate, and the adapter treats its absence as a
  // truncated stream.
  frames.push(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] })}\n\n`);
  return frames;
}

/**
 * Kiro's binary framing, built the way `decodeKiroStream` reads it.
 *
 * `[totalLength:u32][headersLength:u32][?:u32][headers][payload][crc:u32]`, where `totalLength`
 * counts itself, headers are `nameLen:u8 name type:u8 valueLen:u16 value`, and the frame must
 * satisfy `12 + headersLength + 4 <= totalLength` or the decoder stops.
 *
 * Each part is a **separate frame**, for the same reason every other fixture in this harness is
 * multi-part: a single joined frame cannot detect a decoder that drops the rest, which is the
 * failure this whole suite exists to catch.
 */
function binaryFrames(parts) {
  const encoder = new TextEncoder();
  const frames = parts.map((text) => {
    // The header name is `:event-type` — the plain form does not fit the u8 length the
    // decoder reads it with, and using it produced frames that decoded to no text at all.
    const name = encoder.encode(':event-type');
    const value = encoder.encode('assistantResponseEvent');
    const headerBytes = new Uint8Array(1 + name.length + 1 + 2 + value.length);
    const view = new DataView(headerBytes.buffer);
    let cursor = 0;
    headerBytes[cursor++] = name.length;
    headerBytes.set(name, cursor); cursor += name.length;
    // 7 is the decoder's string-header type. Any other value makes it stop reading headers
    // mid-frame, so the frames still parse and still count — and every one of them arrives with
    // no event type and no text, which reads as "the adapter dropped the answer" rather than
    // "the fixture declared the wrong enum".
    headerBytes[cursor++] = 7;
    view.setUint16(cursor, value.length); cursor += 2;
    headerBytes.set(value, cursor);

    const payload = encoder.encode(JSON.stringify({ content: text }));
    const total = 12 + headerBytes.length + payload.length + 4;
    const frame = new Uint8Array(total);
    const frameView = new DataView(frame.buffer);
    frameView.setUint32(0, total);
    frameView.setUint32(4, headerBytes.length);
    frameView.setUint32(8, 0);
    frame.set(headerBytes, 12);
    frame.set(payload, 12 + headerBytes.length);
    return frame;
  });
  // One joined buffer, because that is what the transport delivers.
  const joined = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { joined.set(frame, offset); offset += frame.length; }
  return joined;
}

/** The frames as complete SSE payloads, so a test can inspect them individually. */
export function framesFor(request, parts, wireFormat = 'openai') {
  if (wireFormat === 'gemini') return geminiFrames(parts);
  if (wireFormat === 'anthropic') {
    const frames = ['event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'contract', model: 'contract-model' } }) + '\n\n'];
    frames.push('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');
    for (const content of parts) {
      frames.push('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } }) + '\n\n');
    }
    frames.push('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
    // The finish reason arrives in `message_delta`, not in `message_stop`. Without this frame the
    // adapter correctly reports that the stream ended before completion — so the harness was
    // modelling a stream Anthropic never sends.
    frames.push('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + '\n\n');
    frames.push('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
    return frames;
  }
  const frames = parts.map((content, index) =>
    `data: ${JSON.stringify({
      id: 'contract',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'contract-model',
      choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content } : { content }, finish_reason: null }],
    })}\n\n`,
  );
  frames.push(`data: ${JSON.stringify({ id: 'contract', object: 'chat.completion.chunk', created: 0, model: 'contract-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  frames.push('data: [DONE]\n\n');
  return frames;
}
