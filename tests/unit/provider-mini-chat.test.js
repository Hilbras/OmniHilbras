import { describe, it, expect } from "vitest";
import {
  buildReplayHistory,
  extractDelta,
} from "../../src/shared/utils/providerMiniChat.js";

describe("provider mini chat", () => {
  describe("extractDelta", () => {
    it("reads the streamed content out of an OpenAI-style frame", () => {
      const frame = JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      });

      expect(extractDelta(frame)).toEqual({ text: "Hello", error: "", done: false });
    });

    it("keeps the pieces of a split answer apart", () => {
      const first = extractDelta(JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }));
      const second = extractDelta(JSON.stringify({ choices: [{ delta: { content: "lo" } }] }));

      expect(first.text).toBe("Hel");
      expect(second.text).toBe("lo");
      expect(first.text + second.text).toBe("Hello");
    });

    it("returns nothing for a frame that carries no content", () => {
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });

      expect(extractDelta(frame)).toEqual({ text: "", error: "", done: false });
    });

    it("recognises the end of the stream", () => {
      expect(extractDelta("[DONE]")).toEqual({ text: "", error: "", done: true });
    });

    it("ignores empty frames and malformed JSON", () => {
      expect(extractDelta("")).toEqual({ text: "", error: "", done: false });
      expect(extractDelta("   ")).toEqual({ text: "", error: "", done: false });
      expect(extractDelta("{not json")).toEqual({ text: "", error: "", done: false });
      expect(extractDelta(null)).toEqual({ text: "", error: "", done: false });
    });

    it("falls back to a non-streamed message body", () => {
      const frame = JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "A full answer" } }],
      });

      expect(extractDelta(frame).text).toBe("A full answer");
    });

    it("surfaces a refusal that arrives inside a 200 response", () => {
      const frame = JSON.stringify({
        error: { message: "I cannot help with that request." },
      });

      expect(extractDelta(frame)).toEqual({
        text: "",
        error: "I cannot help with that request.",
        done: false,
      });
    });

    it("surfaces a plain string error", () => {
      expect(extractDelta(JSON.stringify({ error: "model is overloaded" })).error)
        .toBe("model is overloaded");
    });

    it("surfaces an error envelope with a non-200 status", () => {
      const frame = JSON.stringify({ status: 429, msg: "rate limit reached" });

      expect(extractDelta(frame).error).toBe("rate limit reached");
    });

    it("does not treat a 200 envelope as an error", () => {
      const frame = JSON.stringify({ status: 200, msg: "ok", choices: [{ delta: { content: "hi" } }] });

      expect(extractDelta(frame)).toEqual({ text: "hi", error: "", done: false });
    });
  });

  describe("buildReplayHistory", () => {
    it("keeps the visible turns in order", () => {
      const history = buildReplayHistory([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);

      expect(history).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
    });

    it("never replays a failed turn as if the model had said it", () => {
      const history = buildReplayHistory([
        { role: "user", content: "hi" },
        { role: "assistant", content: "", status: "error", error: "I cannot help with that." },
        { role: "user", content: "never mind" },
      ]);

      expect(history).toEqual([
        { role: "user", content: "hi" },
        { role: "user", content: "never mind" },
      ]);
      expect(history.some((message) => message.content.includes("cannot help"))).toBe(false);
    });

    it("drops empty and unknown messages", () => {
      const history = buildReplayHistory([
        { role: "user", content: "" },
        { role: "assistant", content: "kept" },
        { role: "system", content: "ignored" },
        null,
      ]);

      expect(history).toEqual([{ role: "assistant", content: "kept" }]);
    });

    it("returns an empty list for a missing history", () => {
      expect(buildReplayHistory(undefined)).toEqual([]);
      expect(buildReplayHistory(null)).toEqual([]);
    });
  });
});
