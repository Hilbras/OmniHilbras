import { describe, expect, it, vi } from "vitest";

import { readResponseText, readResponseJson } from "../../open-sse/utils/responseBody.js";

/**
 * The upstream body ceiling.
 *
 * A provider's response is accepted (the connect timeout is long past by then)
 * and then buffered whole. Without a ceiling, a provider that sends a
 * 2 GB body — or one that never stops — takes the gateway's memory with it.
 */
function responseWithBytes(bytes) {
  const chunk = new Uint8Array(bytes).fill(65); // "A"
  return {
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: chunk };
          },
          cancel: async () => {},
        };
      },
    },
    text: async () => "A".repeat(bytes),
  };
}

describe("bounded upstream body reads", () => {
  it("reads a body that is within the limit", async () => {
    const text = await readResponseText(responseWithBytes(1024), 4096);
    expect(text.length).toBe(1024);
  });

  it("refuses a body that is over the limit", async () => {
    await expect(readResponseText(responseWithBytes(8192), 4096)).rejects.toThrow(/exceeded/);
  });

  it("counts the bytes that actually arrive, not the content-length header", async () => {
    // A provider that lies about its size must not get past the ceiling.
    const lying = {
      headers: { get: () => "1" },
      body: responseWithBytes(8192).body,
    };
    await expect(readResponseText(lying, 4096)).rejects.toThrow(/exceeded/);
  });

  it("parses JSON from a bounded body", async () => {
    const payload = JSON.stringify({ ok: true });
    const response = {
      body: {
        getReader: () => {
          let sent = false;
          const bytes = new TextEncoder().encode(payload);
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            },
            cancel: async () => {},
          };
        },
      },
      text: async () => payload,
    };
    expect(await readResponseJson(response, 4096)).toEqual({ ok: true });
  });

  it("says so when the body is not JSON", async () => {
    const response = {
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
      text: async () => "not json",
    };
    await expect(readResponseJson(response, 4096)).rejects.toThrow(/not valid JSON/);
  });
});
