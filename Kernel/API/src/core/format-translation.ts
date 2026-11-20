import { invalidRequest, isRecord } from './http.js';

/**
 * Direct format translations (Phase 7 of the full-system upgrade).
 *
 * Anthropic SDK clients speak `/v1/messages` — a system field, content blocks, tool_use/tool_result — not
 * OpenAI's chat shape. The old route only accepted `count_tokens`; a real `POST /v1/messages` 404'd. This
 * module is the direct translator: one source format maps to the chat request the adapters already accept,
 * registered in one table so a pair can be added without editing the route. It is deliberately a *format*
 * translation, not a routing decision — the gateway still picks the connection by the model id, and the
 * reply is reframed back into Anthropic's shape by `chatToMessagesBody`.
 *
 * The RTK half of Phase 7 needs no new code: `Kernel/TokenSaver` already ships `compressRtk`,
 * `autoDetectFilter`, per-tool filters and telemetry (`src/rtk.ts`, `src/filters/`, `src/messages.ts`).
 *
 * The translation has to survive a real agent turn, not just a single ping. Agent clients send the whole
 * tool loop back as history: an assistant `tool_use` block followed by a **user** message whose content is a
 * `tool_result` block. In chat shape a tool result is its own `role: tool` message carrying `tool_call_id`;
 * emitting it as a content part of the user message is refused by `parseContent` with `INVALID_REQUEST`.
 * That is why this function returns a *list* of chat messages: one Anthropic message may fan out into several.
 */

export type TranslationPair = { source: string; target: string; translate: (body: unknown) => Record<string, unknown> };

/** Anthropic `system` accepts a string or content blocks; collate to one string. */
function anthropicSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .filter(isRecord)
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n');
    return text || undefined;
  }
  throw invalidRequest('system must be a string or a list of text blocks.');
}

/** Anthropic `tool_result.content` is a string or a list of text blocks; adapters want one string. */
function anthropicToolResultContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('');
  }
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Translate one Anthropic message into one or more chat messages.
 *
 * Text and image blocks stay in the message they arrived in. `tool_use` blocks become `tool_calls` on the
 * assistant message. `tool_result` blocks become separate `role: tool` messages — the chat parser requires
 * `tool_call_id` on those, and refuses any message whose content contains a `tool_result` part.
 */
function anthropicMessageToChat(message: Record<string, unknown>): Record<string, unknown>[] {
  if (message.role !== 'user' && message.role !== 'assistant') throw invalidRequest('Anthropic message role must be user or assistant.');
  const content = message.content;
  if (typeof content === 'string' || content === null || content === undefined) {
    return [{ role: message.role, content: content ?? null }];
  }
  if (!Array.isArray(content)) throw invalidRequest('Anthropic message content must be a string or a block array.');

  const out: Record<string, unknown>[] = [];
  let parts: unknown[] = [];
  let toolCalls: unknown[] = [];
  let reasoning = '';

  const flush = () => {
    if (!parts.length && !toolCalls.length && !reasoning) return;
    out.push({
      role: message.role,
      // An assistant turn that only calls tools has no text; `null` is the chat shape for that.
      content: parts.length ? parts : null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });
    parts = [];
    toolCalls = [];
    reasoning = '';
  };

  for (const block of content) {
    if (!isRecord(block)) throw invalidRequest('Anthropic content blocks must be objects.');
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalidRequest('Anthropic text blocks need text.');
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const source = isRecord(block.source) ? block.source : undefined;
      if (source?.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
        throw invalidRequest('Anthropic image blocks need a base64 source with media_type.');
      }
      parts.push({ type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } });
    } else if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') throw invalidRequest('tool_use blocks need id and name.');
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) } });
    } else if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string') throw invalidRequest('tool_result blocks need tool_use_id.');
      // A tool result closes the current chat message; the next text block starts a new one.
      flush();
      out.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: anthropicToolResultContent(block.content),
        ...(block.is_error === true ? { is_error: true } : {}),
      });
    } else if (block.type === 'thinking') {
      // Agent histories replay extended-thinking blocks. Keep them as reasoning text on the assistant
      // message rather than rejecting a whole conversation the client considers ordinary.
      if (typeof block.thinking === 'string' && block.thinking) reasoning += (reasoning ? '\n' : '') + block.thinking;
    } else if (block.type === 'redacted_thinking') {
      // Opaque by design; keep a marker so the history is not silently rewritten as an empty turn.
      reasoning += (reasoning ? '\n' : '') + '[redacted thinking]';
    } else {
      throw invalidRequest(`Unsupported Anthropic content block type: ${String(block.type)}.`);
    }
  }
  flush();
  return out.length ? out : [{ role: message.role, content: null }];
}

/** Anthropic `tools` → chat tools. */
function anthropicTools(tools: unknown): unknown[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw invalidRequest('Anthropic tools must be a list.');
  return tools.map((tool) => {
    if (!isRecord(tool)) throw invalidRequest('Each tool must be an object.');
    if (typeof tool.name !== 'string') throw invalidRequest('Each tool needs a name.');
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
      },
    };
  });
}

/**
 * Anthropic tool_choice → the chat vocabulary. `type: tool` cannot name a specific function in the chat
 * shape, so it becomes `required` — the provider is still forced to call a tool, which is what agents ask
 * for. Dropping it (the first version of this translator did) silently broke forced tool calls.
 */
function anthropicToolChoice(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value === 'auto' || value === 'none' || value === 'required' ? value : undefined;
  if (!isRecord(value)) return undefined;
  if (value.type === 'auto') return 'auto';
  if (value.type === 'any' || value.type === 'tool') return 'required';
  if (value.type === 'none') return 'none';
  return undefined;
}

/** Anthropic extended-thinking budget → the shared reasoning-effort vocabulary. */
function anthropicReasoning(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== 'enabled' || typeof value.budget_tokens !== 'number') return undefined;
  const budget = value.budget_tokens;
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

/** Direct Anthropic Messages → chat translation. */
export function anthropicMessagesToChat(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (!Array.isArray(body.messages)) throw invalidRequest('messages must be a list.');
  const messages: Record<string, unknown>[] = [];
  const system = anthropicSystem(body.system);
  if (system !== undefined) messages.push({ role: 'system', content: system });
  for (const message of body.messages) {
    if (!isRecord(message)) throw invalidRequest('Each message must be an object.');
    messages.push(...anthropicMessageToChat(message));
  }
  const tools = anthropicTools(body.tools);
  const toolChoice = anthropicToolChoice(body.tool_choice);
  const reasoning = anthropicReasoning(body.thinking);
  return {
    model: body.model,
    messages,
    ...(body.stream === undefined ? {} : { stream: body.stream }),
    ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(reasoning === undefined ? {} : { reasoning_effort: reasoning }),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length ? { stop: body.stop_sequences } : {}),
  };
}

/**
 * Chat completion reply → Anthropic Messages shape. Text becomes one `text` block; tool calls become
 * `tool_use` blocks. The streaming companion is `chatToMessagesStreamEvents` in the inference route: it
 * emits the same shape as Anthropic's SSE protocol, which is what agent clients actually consume.
 */
export function chatToMessagesBody(input: {
  id: string;
  model: string;
  createdAt: string;
  content: string;
  toolCalls?: ReadonlyArray<{ id?: string; function: { name: string; arguments: string } }>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (input.content) content.push({ type: 'text', text: input.content });
  for (const call of input.toolCalls ?? []) {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      // A malformed argument string is not valid Anthropic input; keep it empty rather than emit a broken block.
    }
    content.push({
      type: 'tool_use',
      id: call.id ?? `toolu_${input.id}`,
      name: call.function.name,
      input: isRecord(args) ? args : {},
    });
  }
  return {
    id: anthropicMessageId(input.id),
    type: 'message',
    role: 'assistant',
    model: input.model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: input.toolCalls?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    created_at: input.createdAt,
    usage: anthropicUsage(input.usage),
  };
}

/** Anthropic clients recognise ids with the `msg_` prefix; keep a stable suffix from the gateway id. */
export function anthropicMessageId(id: string): string {
  return id.startsWith('msg_') ? id : `msg_${id.replace(/^resp_/, '')}`;
}

/** Usage fields Anthropic SDKs read, including the cache counters when a provider reports them. */
export function anthropicUsage(usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    ...(usage?.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  };
}

/** The registry: one row per direct source→target pair, so adding a pair needs no route change. */
export const TRANSLATION_PAIRS: readonly TranslationPair[] = [
  { source: 'messages-api', target: 'openai-chat', translate: anthropicMessagesToChat },
];

/** Resolve a direct translator for a source format, or undefined to use the gateway's own shape. */
export function translatorFor(source: string): TranslationPair | undefined {
  return TRANSLATION_PAIRS.find((pair) => pair.source === source);
}
