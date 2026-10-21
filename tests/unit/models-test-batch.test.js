import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The "Test all" button on a provider page.
 *
 * A provider can expose a hundred models, and testing them one at a time from
 * the browser is slow enough that people stop doing it. The route runs them
 * with a small concurrency window and streams one line per model as it lands,
 * so the page can paint each tile while the run is still going.
 */
const setup = { pings: [] };

vi.mock("../../src/app/api/models/test/ping.js", () => ({
  pingModelByKind: async (model, kind) => {
    setup.pings.push({ model, kind });
    if (model.includes("boom")) throw new Error("socket hang up");
    if (model.includes("broken")) {
      return { ok: false, latencyMs: 12, error: "HTTP 402: insufficient balance" };
    }
    return { ok: true, latencyMs: 42, error: null, status: 200 };
  },
}));

const { POST } = await import("../../src/app/api/models/test-batch/route.js");

async function readNdjson(response) {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("POST /api/models/test-batch", () => {
  beforeEach(() => {
    setup.pings.length = 0;
  });

  it("answers one line per model plus a final summary", async () => {
    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ models: ["kr/claude-sonnet-4.5", "kr/gpt-oss:120b"] }),
      }),
    );

    expect(res.status).toBe(200);
    const lines = await readNdjson(res);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ model: "kr/claude-sonnet-4.5", ok: true, latencyMs: 42 });
    expect(lines[1]).toMatchObject({ model: "kr/gpt-oss:120b", ok: true });
    expect(lines[2]).toMatchObject({ done: true, summary: { total: 2, passed: 2, failed: 0 } });
  });

  it("keeps the provider's own words on a failure", async () => {
    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ models: ["kr/broken-model"] }),
      }),
    );
    const lines = await readNdjson(res);

    expect(lines[0]).toMatchObject({ ok: false, error: "HTTP 402: insufficient balance" });
    expect(lines[1]).toMatchObject({ done: true, summary: { total: 1, passed: 0, failed: 1 } });
  });

  it("passes the model kind through to the ping", async () => {
    await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ models: ["kr/m1"], kind: "embedding" }),
      }),
    );
    expect(setup.pings[0]).toEqual({ model: "kr/m1", kind: "embedding" });
  });

  it("defaults to the llm kind", async () => {
    await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ models: ["kr/m1"] }),
      }),
    );
    expect(setup.pings[0].kind).toBe("llm");
  });

  it("refuses an empty model list", async () => {
    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ models: [] }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/models/);
  });

  it("refuses a list that is too long to be worth running", async () => {
    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ models: Array.from({ length: 201 }, (_, i) => `kr/m${i}`) }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("turns a thrown ping into a failed row instead of a broken run", async () => {
    const res = await POST(
      new Request("http://localhost/api/models/test-batch", {
        method: "POST",
        body: JSON.stringify({ models: ["kr/boom", "kr/fine"] }),
      }),
    );
    const lines = await readNdjson(res);

    expect(lines.find((l) => l.model === "kr/boom")).toMatchObject({
      ok: false,
      error: "socket hang up",
    });
    // The run continues: the next model is still tested.
    expect(lines.find((l) => l.model === "kr/fine")).toMatchObject({ ok: true });
    expect(lines[lines.length - 1]).toMatchObject({ done: true, summary: { total: 2, passed: 1, failed: 1 } });
  });
});
