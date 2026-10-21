import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "@/lib/async/mapWithConcurrency.js";

/**
 * Bounded concurrency.
 *
 * `Promise.all(items.map(fn))` starts everything at once — fine for a few
 * database writes, wrong for a hundred upstream pings.
 */
describe("mapWithConcurrency", () => {
  it("keeps the results in the input order", async () => {
    const results = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      async (n) => {
        // Later items finish first, so an order-preserving result is real.
        await new Promise((r) => setTimeout(r, (6 - n) * 2));
        return n * 10;
      },
      2,
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("never has more than `limit` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
      3,
    );
    expect(peak).toBe(3);
  });

  it("starts everything when the limit exceeds the list", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency(
      [1, 2],
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
      50,
    );
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], async () => 1, 4)).toEqual([]);
    expect(await mapWithConcurrency(null, async () => 1, 4)).toEqual([]);
  });
});
