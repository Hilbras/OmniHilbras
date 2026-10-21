import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

/**
 * The stream budgets.
 *
 * The stall budget alone cannot end a request whose provider keeps sending
 * *some* bytes: the timer is re-armed on every chunk, so a provider that
 * drips one byte every few minutes holds the request — and the account's
 * concurrency slot — for as long as it likes.
 *
 * Three budgets, all ending the request through the stream controller (so the
 * terminal frame is still synthesised for the client):
 *  - first chunk: the time to the first upstream byte
 *  - stall: the gap between upstream bytes (the pre-existing behaviour)
 *  - total: the absolute ceiling
 */
function fakeController() {
  const errors = [];
  return {
    controller: {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete: () => {},
      handleError: (e) => errors.push(e?.message),
      handleDisconnect: () => {},
      abort: () => {},
    },
    errors,
  };
}

/**
 * A real upstream stream — the pipeline under test is a real TransformStream
 * chain, so the fake has to be a real ReadableStream too.
 *
 * `chunks` is what the provider sends; the stream then stays open forever,
 * which is the "provider dribbles bytes" case the budgets exist for.
 */
function upstreamThatSends(chunks = []) {
  return {
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        // never closed: the request hangs here on purpose
      },
    }),
  };
}

describe("stream budgets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends a request whose provider never sends a byte", async () => {
    const { controller, errors } = fakeController();
    const transform = new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } });

    pipeWithDisconnect(upstreamThatSends(), transform, controller, null, 60_000, 5_000, 600_000);

    await vi.advanceTimersByTimeAsync(5_001);
    expect(errors.join(" ")).toMatch(/no data/i);
  });

  it("ends a request that outlives the absolute ceiling", async () => {
    const { controller, errors } = fakeController();
    const transform = new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } });

    // A stall budget of 60s and a first-chunk budget of 5s would have fired
    // first; push them out so the total ceiling is the one under test.
    pipeWithDisconnect(upstreamThatSends(), transform, controller, null, 600_000, 600_000, 10_000);

    await vi.advanceTimersByTimeAsync(10_001);
    expect(errors.join(" ")).toMatch(/deadline exceeded/i);
  });

  it("does not fire the first-chunk budget once bytes have arrived", async () => {
    const { controller, errors } = fakeController();
    const transform = new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } });

    // One chunk, then silence: the first-chunk budget is satisfied, so only
    // the stall budget may fire — and the stall budget here is 10 minutes.
    pipeWithDisconnect(upstreamThatSends([1]), transform, controller, null, 600_000, 5_000, 600_000);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(errors.join(" ")).not.toMatch(/no data/i);
  });
});
