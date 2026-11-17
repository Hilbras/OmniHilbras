/**
 * A token count for a provider that will not give one.
 *
 * The usage page showed `—` for every request through a provider that reports no token usage, which is honest but
 * useless: the operator learns nothing about what the request cost. The alternative to silence is not invention — it
 * is an **estimate that says it is an estimate**, which this file computes and which the record stores as
 * `tokensEstimated: true`.
 *
 * ## The method, and why this one
 *
 * Four characters per token, rounded up, minimum one for non-empty text. It is the heuristic every tokenizer
 * documentation warns about, and it is wrong in both directions: English prose is closer to 4, code and JSON closer to
 * 2.5–3, CJK closer to 1–1.5 per character. That is exactly why the result is labelled rather than presented as a
 * measurement.
 *
 * The alternative — shipping a tokenizer per provider — is a dependency per model family, kept in step with each
 * vendor, to produce a number this gateway does not need to be exact: it is not billing anyone, it is telling an
 * operator roughly what a provider that reports nothing has been asked to do. `/v1/usage` says which figures were
 * measured and which were guessed, and the page prints the word.
 *
 * ## What it deliberately does not do
 *
 * - It does not count tool definitions, images or audio. A request with a 4,000-token tool schema will be
 *   underestimated, and the label is what makes that acceptable.
 * - It does not run on a measured record. A provider's own number always wins; this only fills a hole.
 */

/** Roughly how many characters one token spans, with an allowance for whitespace-heavy text. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string | undefined | null): number | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

/**
 * The prompt side: every message's content, including tool-call arguments, because those are tokens the provider was
 * charged for whether or not it reports them.
 */
export function estimatePromptTokens(messages: readonly unknown[] | undefined): number | undefined {
  if (!messages || messages.length === 0) return undefined;
  const text = messages
    .map((message) => {
      if (typeof message === 'string') return message;
      if (message && typeof message === 'object') {
        const record = message as { content?: unknown; tool_calls?: unknown; name?: unknown };
        const parts: string[] = [];
        if (typeof record.content === 'string') parts.push(record.content);
        else if (Array.isArray(record.content)) {
          for (const part of record.content) {
            const text = (part as { text?: unknown })?.text;
            if (typeof text === 'string') parts.push(text);
          }
        }
        if (record.name && typeof record.name === 'string') parts.push(record.name);
        if (record.tool_calls !== undefined) parts.push(JSON.stringify(record.tool_calls));
        return parts.join(' ');
      }
      return '';
    })
    .join('\n');
  return estimateTokens(text);
}
