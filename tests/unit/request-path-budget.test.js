import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The request-path budget.
 *
 * The audit measured the per-request cost of the hot path: 16-20 SQL
 * statements and ~0.6 ms of pure CPU, dominated by the capability lookup
 * (262-333 µs, because 84 % of the catalogue misses the exact tables and
 * falls through to a 111-pattern scan that compiled a fresh RegExp for every
 * pattern).
 *
 * This is the regression guard for that work: the numbers here are the
 * budget. A change that puts the cost back fails the test rather than
 * showing up as a slow gateway later.
 *
 * The budgets are measured in time rather than in SQL statements on purpose.
 * A statement counter has to reach the same database adapter instance the
 * code under test uses, which depends on how the module was resolved; a
 * timing budget cannot get that wrong. It also fails in the safe direction —
 * a loaded machine makes both the cached and the uncached path slower, and
 * only the uncached path crosses the budget.
 */
describe("request path budget", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnihilbras-bench-"));
    process.env.DATA_DIR = tempDir;
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("keeps the capability lookup well under its old cost", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    // Warm the memo, then measure a lookup that misses the exact tables —
    // the 84 % case that used to cost 262-333 µs.
    getCapabilitiesForModel("openrouter", "some/unknown-model-xyz");
    const t0 = performance.now();
    const N = 2000;
    for (let i = 0; i < N; i++) getCapabilitiesForModel("openrouter", "some/unknown-model-xyz");
    const perLookupUs = ((performance.now() - t0) / N) * 1000;
    // The old cost was 262-333 µs; the memoised one is ~18 µs. The budget is
    // deliberately generous — it catches a regression to the old behaviour
    // without failing on a slow machine.
    expect(perLookupUs).toBeLessThan(120);
  });

  it("does not re-read the settings for every read", async () => {
    const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
    // Awaited: the warm-up pays the database open and the migration, and the
    // cache is only filled once that read has landed.
    await getSettings();
    const N = 1000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await getSettings();
    const totalMs = performance.now() - t0;
    // An uncached read is a SQLite round trip each time (~250 µs → ~250 ms
    // for 1000 reads). A cached one still copies the settings (~8 µs → ~8 ms),
    // so the budget sits between the two: it fails if the cache is dropped,
    // and it does not fail on a loaded machine.
    expect(totalMs).toBeLessThan(50);
  });

  it("does not re-read the whole pricing scope for every model", async () => {
    const { getPricingForModel } = await import("@/lib/db/repos/pricingRepo.js");
    await getPricingForModel("openrouter", "some/model");
    const N = 1000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await getPricingForModel("openrouter", "some/model");
    const totalMs = performance.now() - t0;
    // The user pricing rows are cached now; the constant pricing lookup
    // costs no statements at all.
    expect(totalMs).toBeLessThan(12);
  });

  it("keeps a model's capabilities independent of the caller's mutations", async () => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const first = getCapabilitiesForModel("openrouter", "anthropic/claude-sonnet-4.5");
    const before = first.contextWindow;
    first.contextWindow = 1;
    const second = getCapabilitiesForModel("openrouter", "anthropic/claude-sonnet-4.5");
    expect(second.contextWindow).toBe(before);
  });
});
