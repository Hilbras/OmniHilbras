import { describe, it, expect } from "vitest";
import {
  createSaverTelemetry,
  bytesToTokens,
  withCacheFigures,
  formatTelemetryLine,
  CHARS_PER_TOKEN,
  SAVER_IDS,
} from "../../open-sse/rtk/telemetry.js";

describe("saver telemetry", () => {
  it("converts bytes to tokens at the shared ratio", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(bytesToTokens(0)).toBe(0);
    expect(bytesToTokens(-100)).toBe(0);
    expect(bytesToTokens(4)).toBe(1);
    expect(bytesToTokens(4000)).toBe(1000);
  });

  it("accumulates one saver across several records", () => {
    const t = createSaverTelemetry();
    t.record("rtk", { bytesBefore: 1000, bytesAfter: 400, units: 2 });
    t.record("rtk", { bytesBefore: 600, bytesAfter: 200, units: 1 });

    const s = t.summary();
    expect(s.saver.rtk.bytesBefore).toBe(1600);
    expect(s.saver.rtk.bytesAfter).toBe(600);
    expect(s.saver.rtk.bytesSaved).toBe(1000);
    expect(s.saver.rtk.tokensSaved).toBe(250);
    expect(s.saver.rtk.units).toBe(3);
    expect(s.totalBytesSaved).toBe(1000);
  });

  it("clamps a saver that grew the body to zero savings", () => {
    const t = createSaverTelemetry();
    // Caveman/Ponytail ADD a system prompt — that must never read as negative.
    t.record("caveman", { bytesBefore: 100, bytesAfter: 400, ran: true });
    const s = t.summary();
    expect(s.saver.caveman.bytesSaved).toBe(0);
    expect(s.totalBytesSaved).toBe(0);
  });

  it("distinguishes 'ran but matched nothing' from 'never ran'", () => {
    const t = createSaverTelemetry();
    t.markRan("rtk", null);
    const s = t.summary();
    expect(s.saver.rtk).toBeDefined();
    expect(s.saver.rtk.bytesSaved).toBe(0);
    expect(s.saver.headroom).toBeUndefined();
  });

  it("returns null when nothing was recorded", () => {
    const t = createSaverTelemetry();
    expect(t.summary()).toBeNull();
    expect(t.hasData()).toBe(false);
  });

  it("keeps the last detail and accepts array details", () => {
    const t = createSaverTelemetry();
    t.record("rtk", { bytesBefore: 10, bytesAfter: 5, detail: ["grep"] });
    t.record("rtk", { bytesBefore: 10, bytesAfter: 5, detail: ["ls", "tree"] });
    expect(t.summary().saver.rtk.detail).toEqual(["ls", "tree"]);
  });

  it("never throws on malformed input", () => {
    const t = createSaverTelemetry();
    expect(() => t.record(null, {})).not.toThrow();
    expect(() => t.record("rtk", null)).not.toThrow();
    expect(() => t.record("rtk", { bytesBefore: "nope", bytesAfter: {} })).not.toThrow();
    expect(t.summary()).not.toBeNull();
  });

  it("only accepts the declared saver ids in a summary", () => {
    const t = createSaverTelemetry();
    for (const id of SAVER_IDS) t.markRan(id);
    const s = t.summary();
    expect(Object.keys(s.saver).sort()).toEqual([...SAVER_IDS].sort());
  });

  it("attaches cache figures from provider usage", () => {
    const t = createSaverTelemetry();
    t.record("rtk", { bytesBefore: 100, bytesAfter: 0 });
    const withCache = withCacheFigures(t.summary(), { prompt_tokens: 500, cached_tokens: 200 });
    expect(withCache.cache).toEqual({ read: 200, create: 0 });

    const claudeShape = withCacheFigures(t.summary(), {
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    });
    expect(claudeShape.cache).toEqual({ read: 300, create: 100 });

    // No cache figures → no cache key, so the stats page can tell "unknown"
    // apart from "zero".
    expect(withCacheFigures(t.summary(), { prompt_tokens: 10 }).cache).toBeUndefined();
  });

  it("formats a log line only when something was actually saved", () => {
    const t = createSaverTelemetry();
    t.markRan("caveman");
    expect(formatTelemetryLine(t.summary())).toBeNull();

    t.record("rtk", { bytesBefore: 800, bytesAfter: 0 });
    expect(formatTelemetryLine(t.summary())).toBe("SAVED 800B (~200tok)");
  });
});
