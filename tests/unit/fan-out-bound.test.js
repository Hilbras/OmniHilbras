// Bound on the upstream fan-out of a single client request.
//
// A combo tries each of its models against each provider account, and a
// fusion combo runs every panel model in parallel plus a judge call. Without a
// bound, one client request could drain the operator's provider accounts. The
// budget is created per client request and spent by the upstream calls.
import { describe, it, expect, vi } from "vitest";

import {
  createFanOutBudget,
  consumeFanOutSlot,
  fanOutRemaining,
  fanOutLimitResponse,
} from "../../open-sse/services/fanOut.js";
import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function okResponse(content) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  return make();
}

function errResponse(status = 500) {
  const make = () => ({ ok: false, status, clone: make, json: async () => ({ error: { message: "boom" } }) });
  return make();
}

describe("fan-out budget", () => {
  it("caps the number of upstream calls of one request", () => {
    const budget = createFanOutBudget(2);
    expect(fanOutRemaining(budget)).toBe(2);
    expect(consumeFanOutSlot(budget, "a")).toBe(true);
    expect(consumeFanOutSlot(budget, "b")).toBe(true);
    expect(consumeFanOutSlot(budget, "c")).toBe(false);
    expect(budget.exhausted).toBe(true);
    expect(fanOutRemaining(budget)).toBe(0);
  });

  it("is unbounded when no limit is configured", () => {
    const budget = createFanOutBudget(0);
    for (let i = 0; i < 100; i++) expect(consumeFanOutSlot(budget, "m")).toBe(true);
    expect(budget.exhausted).toBe(false);
  });

  it("names the cap in the error the client gets", async () => {
    const budget = createFanOutBudget(4);
    const res = fanOutLimitResponse(budget);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toContain("upstream call limit");
    expect(body.error.message).toContain("4");
  });
});

describe("combo fan-out", () => {
  it("stops at the budget and tells the client the request was too wide", async () => {
    const budget = createFanOutBudget(2);
    let upstreamCalls = 0;
    // Mirrors what the handler does: every upstream attempt spends a slot.
    const handleSingleModel = vi.fn(async () => {
      if (!consumeFanOutSlot(budget, "m")) return fanOutLimitResponse(budget);
      upstreamCalls++;
      return errResponse(500);
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b", "p/c", "p/d"],
      handleSingleModel,
      log,
      comboName: "combo",
      fanOutBudget: budget,
    });

    expect(upstreamCalls).toBe(2);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toContain("upstream call limit");
  });

  it("runs the whole combo when the budget covers it", async () => {
    const budget = createFanOutBudget(10);
    let upstreamCalls = 0;
    const handleSingleModel = vi.fn(async () => {
      if (!consumeFanOutSlot(budget, "m")) return fanOutLimitResponse(budget);
      upstreamCalls++;
      return okResponse("fine");
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      comboName: "combo",
      fanOutBudget: budget,
    });

    expect(upstreamCalls).toBe(1); // the first model succeeded
    expect(res.ok).toBe(true);
  });
});

describe("fusion fan-out", () => {
  it("refuses a panel the budget cannot cover (panel + judge)", async () => {
    const budget = createFanOutBudget(3);
    const handleSingleModel = vi.fn(async () => okResponse("x"));

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      fanOutBudget: budget,
    });

    expect(handleSingleModel).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toContain("upstream call limit");
  });

  it("runs the panel and the judge when the budget covers them", async () => {
    const budget = createFanOutBudget(8);
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (!consumeFanOutSlot(budget, model)) return fanOutLimitResponse(budget);
      seen.push(model);
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      fanOutBudget: budget,
    });

    // 3 panel calls + 1 judge call — all inside the budget.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen).toContain("p/judge");
    expect(res.ok).toBe(true);
  });
});
