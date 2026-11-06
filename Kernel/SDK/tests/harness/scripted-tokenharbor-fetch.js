/**
 * A `fetch` double for Token Harbor Web.
 *
 * `TokenHarborWebAdapter` takes `{ fetch }` and talks to three endpoints before it produces an
 * answer — a profile read, a session create, and the SSE stream — so a transport that returns
 * parsed JSON could not exercise it. Like DeepSeek's, this is a real `fetch` built from real
 * `Response` objects.
 *
 * ## The fixture is the protocol, not an invention of it
 *
 * The shapes below are transcribed from Token Harbor's own client bundle, which is the authority
 * for what the endpoints accept and return:
 *
 * - `POST /api/direct-chat/sessions` with `{ model, temporary }` → `{ session: { id } }`
 * - `POST /api/direct-chat/stream` with `{ sessionId, content, model, webSearch, tz }` → a
 *   **named-event** SSE body: `event: chunk` with `{ delta }` is the answer, `event: thinking`
 *   with `{ delta }` is the reasoning, `event: done` closes it, and `event: error` carries
 *   `{ code, message }`.
 *
 * A fixture copied from the client is the closest thing to a real capture this adapter can have
 * without a live session — and it is the artefact that would have caught the DeepSeek truncation
 * bug, whose tests asserted hand-written frames the real service never sent.
 */
export function scriptedTokenHarborFetch({ parts = ['Hello', ', ', 'world'], status = 200 } = {}) {
  const seen = [];
  const state = { parts, status };

  const impl = async (url, init = {}) => {
    const href = String(url);
    seen.push({ url: href, method: init.method ?? 'GET', headers: init.headers ?? {} });

    if (href.includes('/api/me/profile')) {
      return json(state.status, { ok: state.status === 200 });
    }

    if (href.includes('/api/direct-chat/sessions')) {
      return json(state.status, { session: { id: 'session-from-fixture' } });
    }

    if (href.includes('/api/direct-chat/stream')) {
      return new Response(tokenHarborStream(state.parts), {
        status: state.status,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    return json(404, { error: { code: 'not_found', message: `the fixture has no answer for ${href}` } });
  };

  /** Sets the answer the next stream will carry, as `chunk` events. */
  impl.set = (next) => { state.parts = next; };
  /** Makes every call answer with one status, for the refusal tests. */
  impl.setStatus = (next) => { state.status = next; };
  impl.seen = seen;

  return impl;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A reply as named events.
 *
 * The multi-part answer arrives as several `chunk` events rather than one, because a decoder that
 * keeps only the first frame must fail — the exact fault that shipped in DeepSeek Web. A
 * `thinking` event is included so a decoder that appends every `delta` regardless of the event
 * name is caught reading reasoning as the answer.
 */
function tokenHarborStream(parts) {
  const blocks = [
    'event: thinking\ndata: {"delta":"considering"}',
    ...parts.map((delta) => `event: chunk\ndata: ${JSON.stringify({ delta })}`),
    'event: done\ndata: {}',
  ];
  return blocks.join('\n\n') + '\n\n';
}