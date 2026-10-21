// copyToClipboard — the clipboard write is awaited and every failure is
// reported as `false` instead of an exception, so the caller only claims
// "Copied!" when the text really made it.
import { describe, it, expect, afterEach } from "vitest";
import { copyToClipboard } from "@/shared/hooks/clipboard.js";

const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;

function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

function setDocument(value) {
  Object.defineProperty(globalThis, "document", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setNavigator(originalNavigator);
  setDocument(originalDocument);
});

describe("copyToClipboard", () => {
  it("writes the text through the async clipboard API", async () => {
    const written = [];
    setNavigator({
      clipboard: {
        writeText: async (text) => {
          written.push(text);
        },
      },
    });

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(written).toEqual(["hello"]);
  });

  it("waits for the write before it reports success", async () => {
    let resolveWrite;
    const pending = new Promise((resolve) => {
      resolveWrite = resolve;
    });
    setNavigator({ clipboard: { writeText: () => pending } });

    let settled = false;
    const copy = copyToClipboard("slow").then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveWrite();
    await expect(copy).resolves.toBe(true);
  });

  it("reports a rejected write as a failure instead of throwing", async () => {
    setNavigator({
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });

    await expect(copyToClipboard("nope")).resolves.toBe(false);
  });

  it("falls back to execCommand when the clipboard API is missing", async () => {
    setNavigator({});
    const calls = [];
    setDocument({
      body: {
        appendChild: () => {},
        removeChild: () => {},
      },
      createElement: () => ({
        value: "",
        style: {},
        select: () => {},
      }),
      execCommand: (command) => {
        calls.push(command);
        return true;
      },
    });

    await expect(copyToClipboard("fallback")).resolves.toBe(true);
    expect(calls).toEqual(["copy"]);
  });

  it("reports a missing clipboard as a failure", async () => {
    setNavigator({});
    setDocument(undefined);

    await expect(copyToClipboard("nowhere")).resolves.toBe(false);
  });
});
