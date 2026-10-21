/**
 * Pure helpers for the provider mini chat panel.
 *
 * The frame parser and the markdown parser live here rather than inside the
 * component so they can be unit tested: the dashboard's test runner transforms
 * plain `.js` files with esbuild's JS loader, which cannot parse JSX.
 *
 * Safety note for the markdown parser: it never produces HTML. It returns a
 * tree of plain strings, and the component renders those strings as React
 * children, so React escapes them. Nothing in this feature touches
 * `dangerouslySetInnerHTML`, so an answer that contains
 * `<img src=x onerror=alert(1)>` is shown as that literal text and can never
 * become markup.
 */

const DONE_MARKER = "[DONE]";

function asText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).join("");
  return "";
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The provider's own words, when the frame carries a refusal instead of an
 * answer. A provider that refuses usually answers HTTP 200 and puts the
 * refusal in the body, so the body has to be read for it.
 */
function extractFrameError(parsed) {
  const error = parsed.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const message = error.message || error.msg || error.error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  // Envelopes like { status: 429, msg: "rate limited" } — a status other than
  // 200 means the provider is reporting a failure.
  const status = parsed.status;
  if (status !== undefined && status !== null) {
    const code = String(status);
    if (code !== "200" && code !== "0") {
      const message = parsed.msg || parsed.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }

  return "";
}

/**
 * The token/credit counters a provider may report on the last frame.
 *
 * The gateway reports the OpenAI counters plus the provider's own currency
 * (`kiro_credits`), so both spellings are accepted. A frame without any
 * usable counter returns null rather than an empty object: "the provider said
 * nothing about tokens" and "the provider said zero tokens" are different
 * facts, and only one of them should reach the turn's metadata.
 *
 * @param {object|null} usage the raw `usage` object of a frame
 * @returns {{ promptTokens: number|null, completionTokens: number|null,
 *   totalTokens: number|null, credits: number|null, creditUnit: string }|null}
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = toNumber(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens);
  const completionTokens = toNumber(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens);
  const totalTokens = toNumber(usage.total_tokens ?? usage.totalTokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const credits = toNumber(usage.kiro_credits ?? usage.credits ?? usage.credit ?? usage.credit_amount);
  const creditUnit = firstString(usage.kiro_credit_unit, usage.credit_unit, usage.creditUnit, usage.unit);

  if (promptTokens === null && completionTokens === null && totalTokens === null && credits === null) return null;

  return { promptTokens, completionTokens, totalTokens, credits, creditUnit };
}

function emptyFrame() {
  return {
    text: "",
    reasoning: "",
    error: "",
    done: false,
    finishReason: "",
    usage: null,
  };
}

/**
 * Parse one SSE `data:` payload.
 *
 * A reasoning model splits its answer in two: the thinking arrives in
 * `delta.reasoning_content` (some providers use `delta.thinking`) and the
 * answer in `delta.content`. The last frame of a stream also carries the
 * stop reason and the token/credit counters, which is what lets a tester
 * judge a model instead of guessing.
 *
 * @param {string} frame the raw payload of a `data:` line (no `data:` prefix)
 * @returns {{ text: string, reasoning: string, error: string, done: boolean,
 *   finishReason: string, usage: object|null }} the streamed text piece, the
 *   streamed thinking piece, the provider's refusal (if the frame carries
 *   one), whether the frame closed the stream, the stop reason and the usage.
 */
export function extractDelta(frame) {
  const payload = typeof frame === "string" ? frame.trim() : "";
  if (!payload) return emptyFrame();
  if (payload === DONE_MARKER) return { ...emptyFrame(), done: true };

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A malformed frame is not worth breaking the stream over.
    return emptyFrame();
  }
  if (!parsed || typeof parsed !== "object") return emptyFrame();

  const error = extractFrameError(parsed);
  if (error) return { ...emptyFrame(), error };

  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  const delta = choice?.delta || {};
  const text = asText(delta.content) || asText(choice?.message?.content);
  const reasoning = asText(delta.reasoning_content)
    || asText(delta.thinking)
    || asText(delta.reasoning);
  const finishReason = firstString(choice?.finish_reason, choice?.finishReason);

  return {
    text,
    reasoning,
    error: "",
    done: parsed.done === true,
    finishReason,
    usage: normalizeUsage(parsed.usage),
  };
}

/**
 * The history that may be replayed to the model.
 *
 * A turn that failed carries the provider's own words. That text is the
 * provider's report about the failure, not something the model said, so it
 * never goes back to the model. The user's own message stays in: the model
 * never answered it, and dropping it would lose the question.
 *
 * @param {Array<{ role?: string, content?: string, status?: string }>} messages
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildReplayHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && message.status !== "error")
    .filter((message) => (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string" && message.content.length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}

/**
 * The messages the gateway actually receives.
 *
 * The system prompt is sent as the leading system message, the way every
 * OpenAI-compatible provider expects it. It is kept out of the conversation
 * history so that the transcript stays a conversation and the prompt stays a
 * setting.
 *
 * @param {Array<{ role?: string, content?: string }>} history
 * @param {string} [system] the system prompt
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildUpstreamMessages(history, system) {
  const clean = (Array.isArray(history) ? history : [])
    .filter((message) => message
      && (message.role === "user" || message.role === "assistant" || message.role === "system")
      && typeof message.content === "string" && message.content.length > 0)
    .map((message) => ({ role: message.role, content: message.content }));

  const prompt = typeof system === "string" ? system.trim() : "";
  if (!prompt) return clean;
  return [{ role: "system", content: prompt }, ...clean];
}

/* ------------------------------------------------------------------ *
 * Formatting helpers for the turn metadata
 * ------------------------------------------------------------------ */

/** 4137 -> "4,137". */
export function formatCount(value) {
  const number = toNumber(value);
  if (number === null) return "";
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 823 -> "823ms", 1234 -> "1.2s", 12345 -> "12s". */
export function formatDuration(milliseconds) {
  const number = toNumber(milliseconds);
  if (number === null || number < 0) return "";
  if (number < 1000) return `${Math.round(number)}ms`;
  const seconds = number / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/** { credits: 0.0182, creditUnit: "credit" } -> "0.0182 credit". */
export function formatCredits(usage) {
  if (!usage || typeof usage !== "object") return "";
  const credits = toNumber(usage.credits);
  if (credits === null) return "";
  const unit = firstString(usage.creditUnit) || "credit";
  const value = Number.isInteger(credits) ? String(credits) : String(Number(credits.toFixed(6)));
  return `${value} ${unit}`;
}

/* ------------------------------------------------------------------ *
 * Markdown
 *
 * A small parser written for this panel. It is deliberately not a general
 * CommonMark implementation: it covers what models actually answer with
 * (paragraphs, headings, emphasis, inline code, fenced code, lists, quotes
 * and rules) and nothing else.
 *
 * Two rules shape the whole thing:
 *
 * 1. It returns data, never HTML. The output is a list of blocks made of
 *    plain strings; the component turns those into React elements. There is
 *    no HTML anywhere in the pipeline, so there is nothing to sanitise and no
 *    way for a model answer to inject markup into the dashboard.
 * 2. It never guesses. An unclosed fence stays a code block, an unmatched
 *    emphasis marker stays literal text. Half-written answers arrive all the
 *    time while a response streams in, and the parser has to stay honest
 *    about what it has actually seen.
 * ------------------------------------------------------------------ */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\n]*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const RULE = /^ {0,3}(?:([-*_])[ \t]*){3,}$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)([0-9]{1,9})[.)][ \t]+(.*)$/;

function indentWidth(whitespace) {
  let width = 0;
  for (const char of whitespace) {
    // A tab is worth four columns, so an indented block under a tab reads
    // the same as one indented under four spaces.
    width += char === "\t" ? 4 : 1;
  }
  return width;
}

function leadingIndent(line) {
  return indentWidth((/^[ \t]*/.exec(line) || [""])[0]);
}

function matchFence(line) {
  const match = FENCE.exec(line);
  if (!match) return null;
  return {
    char: match[1][0],
    length: match[1].length,
    lang: (match[2] || "").trim(),
    indent: (/^ */.exec(line) || [""])[0].length,
  };
}

function matchHeading(line) {
  const match = HEADING.exec(line);
  if (!match) return null;
  // "## Title ##" is a title, not a title with hashes in it.
  return { level: match[1].length, text: match[2].replace(/[ \t]+#+[ \t]*$/, "") };
}

function isRule(line) {
  return RULE.test(line);
}

function isQuote(line) {
  return QUOTE.test(line);
}

function matchListItem(line) {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { indent: indentWidth(bullet[1]), ordered: false, text: bullet[3] };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return { indent: indentWidth(ordered[1]), ordered: true, text: ordered[3] };
  }
  return null;
}

/** True for a line that opens a block of its own (fence, heading, rule, quote). */
function isBlockStart(line) {
  return Boolean(matchFence(line) || matchHeading(line) || isRule(line) || isQuote(line));
}

function stripIndent(line, width) {
  let count = 0;
  while (count < width && line[count] === " ") count += 1;
  return line.slice(count);
}

/**
 * Read a fenced code block.
 *
 * The block ends at a fence of the same character that is at least as long as
 * the opening one. When no such fence arrives the block runs to the end of
 * the text and stays a code block: a half-streamed answer must not spill its
 * code into the rest of the page.
 */
function readFence(lines, start, fence) {
  const closing = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`);
  const content = [];
  let index = start + 1;

  while (index < lines.length) {
    const line = lines[index];
    if (closing.test(line)) {
      index += 1;
      break;
    }
    content.push(stripIndent(line, fence.indent));
    index += 1;
  }

  return { code: content.join("\n"), next: index };
}

/** Read the consecutive quote lines into one inline run. */
function readQuote(lines, start) {
  const quoted = [];
  let index = start;

  while (index < lines.length) {
    const match = QUOTE.exec(lines[index]);
    if (!match) break;
    quoted.push(match[1]);
    index += 1;
  }

  const spans = [];
  quoted.forEach((line, position) => {
    if (position > 0) spans.push({ type: "text", text: "\n" });
    spans.push(...parseInline(line));
  });

  return { spans, next: index };
}

/**
 * Read a list.
 *
 * Items nest by indentation: an item indented deeper than the list it sits
 * in becomes a nested list inside that item. A blank line only ends the list
 * when nothing that belongs to it follows, and a plain line right under an
 * item belongs to that item (a lazy continuation), the way CommonMark reads
 * it.
 *
 * @returns {{ block: object, next: number }}
 */
function readList(lines, start) {
  const first = matchListItem(lines[start]);
  const baseIndent = first.indent;
  const root = { ordered: first.ordered, items: [] };
  // Each stack entry is a list that is currently open; `indent` is the
  // indentation of the items that belong to it.
  const stack = [{ indent: baseIndent, list: root }];
  let currentItem = null;
  let index = start;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      let look = index + 1;
      while (look < lines.length && !lines[look].trim()) look += 1;
      if (look >= lines.length) {
        index = look;
        break;
      }
      const nextItem = matchListItem(lines[look]);
      if (nextItem && nextItem.indent >= baseIndent) {
        index = look;
        continue;
      }
      if (!nextItem && isIndentedContinuation(lines[look], baseIndent)) {
        index = look;
        continue;
      }
      index = look;
      break;
    }

    const item = matchListItem(line);
    if (item) {
      if (item.indent < baseIndent) break;

      // Close the levels this item has left.
      while (stack.length > 1 && stack[stack.length - 1].indent > item.indent) stack.pop();
      const level = stack[stack.length - 1];

      if (item.indent > level.indent) {
        // A deeper item opens a nested list inside the item it follows.
        const nested = { type: "list", ordered: item.ordered, items: [] };
        currentItem.blocks.push(nested);
        stack.push({ indent: item.indent, list: nested });
      } else if (level.list.ordered !== item.ordered) {
        // A different kind of marker starts a different list.
        break;
      }

      currentItem = { blocks: [{ type: "paragraph", spans: parseInline(item.text) }] };
      stack[stack.length - 1].list.items.push(currentItem);
      index += 1;
      continue;
    }

    if (isBlockStart(line)) break;

    // A lazy continuation: the line belongs to the item above it.
    if (currentItem) {
      currentItem.blocks.push({ type: "paragraph", spans: parseInline(line.trim()) });
    }
    index += 1;
  }

  return { block: { type: "list", ordered: root.ordered, items: root.items }, next: index };
}

function isIndentedContinuation(line, baseIndent) {
  if (!line.trim()) return false;
  if (matchListItem(line)) return false;
  if (isBlockStart(line)) return false;
  return leadingIndent(line) > baseIndent;
}

/**
 * Parse a piece of text into inline spans.
 *
 * The order of the checks matters: inline code is checked first because its
 * content is literal — a backtick inside `` `code` `` is text, not a marker.
 * Emphasis is checked before the single-character markers so that `**bold**`
 * is never read as two empty italics.
 *
 * @param {string} source
 * @returns {Array<{ type: "text"|"bold"|"italic"|"code"|"strike", text: string }>}
 */
export function parseInline(source) {
  const text = typeof source === "string" ? source : "";
  const spans = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (!buffer) return;
    spans.push({ type: "text", text: buffer });
    buffer = "";
  };

  while (index < text.length) {
    const rest = text.slice(index);

    if (rest[0] === "`") {
      const match = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest);
      if (match) {
        flush();
        spans.push({ type: "code", text: match[2].replace(/\n/g, " ") });
        index += match[0].length;
        continue;
      }
    }

    if (rest.startsWith("~~")) {
      const close = text.indexOf("~~", index + 2);
      if (close > index + 2 && !/\s/.test(text[close - 1])) {
        flush();
        pushWrapped(spans, "strike", text.slice(index + 2, close));
        index = close + 2;
        continue;
      }
    }

    if (rest.startsWith("**")) {
      const close = text.indexOf("**", index + 2);
      if (close > index + 2 && !/\s/.test(text[close - 1]) && !/\s/.test(text[index + 2])) {
        flush();
        pushWrapped(spans, "bold", text.slice(index + 2, close));
        index = close + 2;
        continue;
      }
    }

    if (rest[0] === "*" || rest[0] === "_") {
      const marker = rest[0];
      const close = text.indexOf(marker, index + 1);
      const intraword = marker === "_"
        && (/\w/.test(text[index - 1] || "") || /\w/.test(text[close + 1] || ""));
      if (close > index + 1
        && !/\s/.test(text[close - 1])
        && !/\s/.test(text[index + 1])
        && !intraword) {
        flush();
        pushWrapped(spans, "italic", text.slice(index + 1, close));
        index = close + 1;
        continue;
      }
    }

    buffer += rest[0];
    index += 1;
  }

  flush();
  return spans;
}

/**
 * Apply an outer emphasis to the spans of the text between the markers.
 *
 * A span carries a single style, so an inner marker that has its own style
 * (inline code, for instance) keeps it; only plain text takes the outer
 * style.
 */
function pushWrapped(spans, type, inner) {
  for (const span of parseInline(inner)) {
    if (span.type === "text") spans.push({ type, text: span.text });
    else spans.push(span);
  }
}

/**
 * Parse a model answer into blocks.
 *
 * @param {string} source the raw answer
 * @returns {Array<object>} a list of blocks, each one of
 *   `{ type: "paragraph", spans }`,
 *   `{ type: "heading", level, spans }`,
 *   `{ type: "code", lang, code }`,
 *   `{ type: "list", ordered, items }` (an item is `{ blocks }`),
 *   `{ type: "quote", spans }` or
 *   `{ type: "rule" }`.
 */
export function parseMarkdown(source) {
  const text = typeof source === "string" ? source : "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = matchFence(line);
    if (fence) {
      const read = readFence(lines, index, fence);
      blocks.push({ type: "code", lang: fence.lang, code: read.code });
      index = read.next;
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, spans: parseInline(heading.text) });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (isQuote(line)) {
      const read = readQuote(lines, index);
      blocks.push({ type: "quote", spans: read.spans });
      index = read.next;
      continue;
    }

    if (matchListItem(line)) {
      const read = readList(lines, index);
      blocks.push(read.block);
      index = read.next;
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) break;
      if (isBlockStart(current) || matchListItem(current)) break;
      paragraph.push(current.trim());
      index += 1;
    }

    if (paragraph.length === 0) {
      index += 1;
      continue;
    }
    blocks.push({ type: "paragraph", spans: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}
