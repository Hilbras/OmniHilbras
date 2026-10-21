import { UPSTREAM_MAX_BODY_BYTES } from "../config/runtimeConfig.js";

/**
 * Read an upstream response body with a size ceiling.
 *
 * A provider that answers with a huge body — or one that never stops sending
 * — must not be able to exhaust the gateway's memory: the response was
 * already accepted (the connect timeout is long past), and `response.text()`
 * buffers the whole thing. The ceiling turns that into a clean 502 instead.
 *
 * The limit is generous enough for a large tool-call payload or a long
 * completion, and it is counted on the bytes that actually arrive, so a
 * lying `content-length` does not get past it.
 */
export async function readResponseText(response, maxBytes = UPSTREAM_MAX_BODY_BYTES) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    // No streaming body (a synthetic response) — read it the plain way.
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error(`upstream response exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength ?? value.length ?? 0;
      if (total > maxBytes) {
        throw new Error(`upstream response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel("bounded upstream body").catch(() => {});
  }

  const decoder = new TextDecoder();
  if (chunks.length === 1) return decoder.decode(chunks[0]);
  let out = "";
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/**
 * The same, parsed as JSON.
 */
export async function readResponseJson(response, maxBytes = UPSTREAM_MAX_BODY_BYTES) {
  const text = await readResponseText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`upstream response is not valid JSON: ${error.message}`);
  }
}
