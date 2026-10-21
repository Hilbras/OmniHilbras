import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildReplayHistory,
  buildUpstreamMessages,
  extractDelta,
  formatCount,
  formatCredits,
  formatDuration,
  normalizeUsage,
  parseInline,
  parseMarkdown,
} from "../../src/shared/utils/providerMiniChat.js";

const COMPONENT_SOURCE = readFileSync(
  new URL("../../src/shared/components/ProviderMiniChat.js", import.meta.url),
  "utf8",
);

const SPAN_TYPES = new Set(["text", "bold", "italic", "code", "strike"]);
const BLOCK_TYPES = new Set(["paragraph", "heading", "code", "list", "quote", "rule"]);

/** Every string the parser produced, whatever shape it was stored in. */
function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
  return out;
}

/** Every span in the tree, including the ones nested inside list items. */
function collectSpans(blocks, out = []) {
  for (const block of blocks) {
    if (block.type === "list") {
      for (const item of block.items) collectSpans(item.blocks || [], out);
      continue;
    }
    for (const span of block.spans || []) out.push(span);
  }
  return out;
}

describe("provider mini chat", () => {
  describe("extractDelta", () => {
    it("reads the streamed content out of an OpenAI-style frame", () => {
      const frame = JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      });

      expect(extractDelta(frame)).toEqual({
        text: "Hello",
        reasoning: "",
        error: "",
        done: false,
        finishReason: "",
        usage: null,
      });
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

      expect(extractDelta(frame)).toEqual({
        text: "",
        reasoning: "",
        error: "",
        done: false,
        finishReason: "stop",
        usage: null,
      });
    });

    it("recognises the end of the stream", () => {
      expect(extractDelta("[DONE]")).toEqual({
        text: "",
        reasoning: "",
        error: "",
        done: true,
        finishReason: "",
        usage: null,
      });
    });

    it("ignores empty frames and malformed JSON", () => {
      const empty = { text: "", reasoning: "", error: "", done: false, finishReason: "", usage: null };
      expect(extractDelta("")).toEqual(empty);
      expect(extractDelta("   ")).toEqual(empty);
      expect(extractDelta("{not json")).toEqual(empty);
      expect(extractDelta(null)).toEqual(empty);
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
        reasoning: "",
        error: "I cannot help with that request.",
        done: false,
        finishReason: "",
        usage: null,
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

      expect(extractDelta(frame)).toEqual({
        text: "hi",
        reasoning: "",
        error: "",
        done: false,
        finishReason: "",
        usage: null,
      });
    });

    it("reads the stop reason off the last frame", () => {
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });

      expect(extractDelta(frame).finishReason).toBe("stop");
    });

    it("reads the usage and the credits the gateway reports", () => {
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 4137,
          completion_tokens: 4,
          total_tokens: 4141,
          kiro_credits: 0.0182,
          kiro_credit_unit: "credit",
        },
      });

      const frame2 = extractDelta(frame);
      expect(frame2.finishReason).toBe("stop");
      expect(frame2.usage).toEqual({
        promptTokens: 4137,
        completionTokens: 4,
        totalTokens: 4141,
        credits: 0.0182,
        creditUnit: "credit",
      });
    });

    it("keeps the thinking out of the answer", () => {
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: "Let me think..." } }],
      });

      const parsed = extractDelta(frame);
      expect(parsed.reasoning).toBe("Let me think...");
      expect(parsed.text).toBe("");
    });

    it("reads the thinking from either reasoning field", () => {
      const reasoning = JSON.stringify({ choices: [{ delta: { reasoning_content: "first" } }] });
      const thinking = JSON.stringify({ choices: [{ delta: { thinking: "second" } }] });

      expect(extractDelta(reasoning).reasoning).toBe("first");
      expect(extractDelta(thinking).reasoning).toBe("second");
    });

    it("carries the answer and the thinking in the same frame", () => {
      const frame = JSON.stringify({
        choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }],
      });

      const parsed = extractDelta(frame);
      expect(parsed.reasoning).toBe("thinking");
      expect(parsed.text).toBe("answer");
    });
  });

  describe("normalizeUsage", () => {
    it("returns null when the provider says nothing about usage", () => {
      expect(normalizeUsage(null)).toBeNull();
      expect(normalizeUsage(undefined)).toBeNull();
      expect(normalizeUsage({})).toBeNull();
    });

    it("adds up the total when only the parts are known", () => {
      expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 }).totalTokens).toBe(15);
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

    it("never replays a failed turn that had already produced text", () => {
      const history = buildReplayHistory([
        { role: "user", content: "hi" },
        { role: "assistant", content: "half an answer", status: "error", error: "the stream broke" },
      ]);

      expect(history).toEqual([{ role: "user", content: "hi" }]);
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

  describe("buildUpstreamMessages", () => {
    it("puts the system prompt in front as a system message", () => {
      const messages = buildUpstreamMessages(
        [{ role: "user", content: "hi" }],
        "Answer in one sentence.",
      );

      expect(messages).toEqual([
        { role: "system", content: "Answer in one sentence." },
        { role: "user", content: "hi" },
      ]);
    });

    it("leaves the conversation alone when there is no system prompt", () => {
      expect(buildUpstreamMessages([{ role: "user", content: "hi" }], "")).toEqual([
        { role: "user", content: "hi" },
      ]);
      expect(buildUpstreamMessages([{ role: "user", content: "hi" }], "   ")).toEqual([
        { role: "user", content: "hi" },
      ]);
    });

    it("drops empty and unknown roles", () => {
      expect(buildUpstreamMessages([
        { role: "user", content: "" },
        { role: "tool", content: "nope" },
        { role: "assistant", content: "kept" },
      ], "")).toEqual([{ role: "assistant", content: "kept" }]);
    });
  });

  describe("formatting", () => {
    it("groups the token counts", () => {
      expect(formatCount(4137)).toBe("4,137");
      expect(formatCount(0)).toBe("0");
      expect(formatCount(null)).toBe("");
    });

    it("reads the latency as milliseconds or seconds", () => {
      expect(formatDuration(823)).toBe("823ms");
      expect(formatDuration(1234)).toBe("1.2s");
      expect(formatDuration(12345)).toBe("12s");
      expect(formatDuration(null)).toBe("");
    });

    it("keeps the provider's own credit unit", () => {
      expect(formatCredits({ credits: 0.0182, creditUnit: "credit" })).toBe("0.0182 credit");
      expect(formatCredits({ credits: 2 })).toBe("2 credit");
      expect(formatCredits(null)).toBe("");
      expect(formatCredits({})).toBe("");
    });
  });

  describe("parseMarkdown", () => {
    it("reads a plain answer as one paragraph", () => {
      expect(parseMarkdown("Hello world.")).toEqual([
        { type: "paragraph", spans: [{ type: "text", text: "Hello world." }] },
      ]);
    });

    it("splits paragraphs on a blank line", () => {
      const blocks = parseMarkdown("First.\n\nSecond.");

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe("paragraph");
      expect(blocks[1].spans[0].text).toBe("Second.");
    });

    it("reads the heading levels", () => {
      const blocks = parseMarkdown("# One\n## Two\n###### Six");

      expect(blocks.map((block) => [block.type, block.level])).toEqual([
        ["heading", 1],
        ["heading", 2],
        ["heading", 6],
      ]);
      expect(blocks[0].spans).toEqual([{ type: "text", text: "One" }]);
    });

    it("does not read a hash without a space as a heading", () => {
      expect(parseMarkdown("#hashtag")[0].type).toBe("paragraph");
    });

    it("reads bold, italic and struck text", () => {
      const spans = parseInline("a **bold** b *italic* c _italic_ d ~~gone~~ e");

      expect(spans).toEqual([
        { type: "text", text: "a " },
        { type: "bold", text: "bold" },
        { type: "text", text: " b " },
        { type: "italic", text: "italic" },
        { type: "text", text: " c " },
        { type: "italic", text: "italic" },
        { type: "text", text: " d " },
        { type: "strike", text: "gone" },
        { type: "text", text: " e" },
      ]);
    });

    it("leaves an unmatched marker as text", () => {
      expect(parseInline("a **bold b")).toEqual([{ type: "text", text: "a **bold b" }]);
    });

    it("keeps an underscore inside a word as text", () => {
      expect(parseInline("snake_case_name")).toEqual([
        { type: "text", text: "snake_case_name" },
      ]);
    });

    it("reads inline code and keeps its content literal", () => {
      const spans = parseInline("run `npm test` now");

      expect(spans).toEqual([
        { type: "text", text: "run " },
        { type: "code", text: "npm test" },
        { type: "text", text: " now" },
      ]);
    });

    it("reads a fenced code block with its language", () => {
      const blocks = parseMarkdown("```js\nconst a = 1;\nconsole.log(a);\n```");

      expect(blocks).toEqual([
        { type: "code", lang: "js", code: "const a = 1;\nconsole.log(a);" },
      ]);
    });

    it("reads a fenced code block without a language", () => {
      const blocks = parseMarkdown("```\nplain\n```");

      expect(blocks).toEqual([{ type: "code", lang: "", code: "plain" }]);
    });

    it("keeps an unclosed fence as a code block", () => {
      const blocks = parseMarkdown("```py\nprint('hi')\nstill code");

      expect(blocks).toEqual([{ type: "code", lang: "py", code: "print('hi')\nstill code" }]);
    });

    it("reads a bullet list", () => {
      const blocks = parseMarkdown("- one\n- two");

      expect(blocks[0].type).toBe("list");
      expect(blocks[0].ordered).toBe(false);
      expect(blocks[0].items).toHaveLength(2);
      expect(blocks[0].items[0].blocks[0].spans[0].text).toBe("one");
    });

    it("reads an ordered list", () => {
      const blocks = parseMarkdown("1. one\n2. two");

      expect(blocks[0].type).toBe("list");
      expect(blocks[0].ordered).toBe(true);
      expect(blocks[0].items).toHaveLength(2);
      expect(blocks[0].items[1].blocks[0].spans[0].text).toBe("two");
    });

    it("nests a list inside the item it belongs to", () => {
      const blocks = parseMarkdown("- one\n  - nested\n- two");

      expect(blocks[0].items).toHaveLength(2);
      const nested = blocks[0].items[0].blocks[1];
      expect(nested.type).toBe("list");
      expect(nested.items[0].blocks[0].spans[0].text).toBe("nested");
    });

    it("reads a quote", () => {
      const blocks = parseMarkdown("> a quoted line");

      expect(blocks[0].type).toBe("quote");
      expect(blocks[0].spans[0].text).toBe("a quoted line");
    });

    it("reads a rule", () => {
      expect(parseMarkdown("---")).toEqual([{ type: "rule" }]);
      expect(parseMarkdown("***")).toEqual([{ type: "rule" }]);
    });

    it("reads a whole answer", () => {
      const blocks = parseMarkdown([
        "# Title",
        "",
        "Some **bold** text.",
        "",
        "```python",
        "print(1)",
        "```",
        "",
        "- first",
        "- second",
        "",
        "> quoted",
        "",
        "---",
      ].join("\n"));

      expect(blocks.map((block) => block.type)).toEqual([
        "heading",
        "paragraph",
        "code",
        "list",
        "quote",
        "rule",
      ]);
    });

    it("returns nothing for an empty answer", () => {
      expect(parseMarkdown("")).toEqual([]);
      expect(parseMarkdown(null)).toEqual([]);
    });

    it("carries HTML as text and never as markup", () => {
      const blocks = parseMarkdown('<img src=x onerror=alert(1)>');

      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("paragraph");
      expect(blocks[0].spans).toEqual([
        { type: "text", text: "<img src=x onerror=alert(1)>" },
      ]);

      // The text is carried as a string in a text span. Nothing in the tree
      // can hold markup: every span is a type and a string, nothing else.
      for (const span of collectSpans(blocks)) {
        expect(Object.keys(span).sort()).toEqual(["text", "type"]);
        expect(SPAN_TYPES.has(span.type)).toBe(true);
        expect(typeof span.text).toBe("string");
      }
    });

    it("carries a script tag as text inside a code block too", () => {
      const blocks = parseMarkdown("```html\n<script>alert(1)</script>\n```");

      expect(blocks[0].type).toBe("code");
      expect(blocks[0].code).toBe("<script>alert(1)</script>");
    });

    it("only ever produces the known block and span types", () => {
      const blocks = parseMarkdown([
        "# Head",
        "",
        "text with **bold** and `code`",
        "",
        "- item",
        "",
        "> quote",
        "",
        "---",
        "",
        "```js",
        "code();",
        "```",
      ].join("\n"));

      for (const block of blocks) {
        expect(BLOCK_TYPES.has(block.type)).toBe(true);
        expect(Object.values(block).every((value) => (
          typeof value === "string"
          || typeof value === "boolean"
          || typeof value === "number"
          || Array.isArray(value)
        ))).toBe(true);
      }
      for (const span of collectSpans(blocks)) {
        expect(SPAN_TYPES.has(span.type)).toBe(true);
      }
    });
  });

  describe("the rendered answer", () => {
    it("never asks React to inject markup", () => {
      expect(COMPONENT_SOURCE).not.toContain("dangerouslySetInnerHTML");
      expect(COMPONENT_SOURCE).not.toContain("innerHTML");
      expect(COMPONENT_SOURCE).not.toContain("document.write");
    });

    it("renders the parsed blocks instead of raw HTML", () => {
      expect(COMPONENT_SOURCE).toContain("parseMarkdown");
      expect(COMPONENT_SOURCE).toContain("MarkdownBlocks");
    });
  });
});
