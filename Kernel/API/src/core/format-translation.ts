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

/** Anthropic content blocks → the chat content parts the adapters understand (same shapes as the Responses bridge). */
function anthropicContent(content: unknown): { content: unknown; toolCalls?: unknown[] } {
  if (typeof content === 'string' || content === null || content === undefined) return { content };
  if (!Array.isArray(content)) throw invalidRequest('Anthropic message content must be a string or a block array.');
  const parts: unknown[] = [];
  const toolCalls: unknown[] = [];
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
      // Anthropic tool_result is a user-role message; the chat parser expects role:tool with tool_call_id.
      parts.push({ type: 'tool_result', tool_call_id: block.tool_use_id, content: block.content });
    } else {
      throw invalidRequest(`Unsupported Anthropic content block type: ${String(block.type)}.`);
    }
  }
  return { content: parts.length ? parts : null, ...(toolCalls.length ? { toolCalls } : {}) };
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

/** Direct Anthropic Messages → chat translation. */
export function anthropicMessagesToChat(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (!Array.isArray(body.messages)) throw invalidRequest('messages must be a list.');
  const messages: Record<string, unknown>[] = [];
  const system = anthropicSystem(body.system);
  if (system !== undefined) messages.push({ role: 'system', content: system });
  for (const message of body.messages) {
    if (!isRecord(message)) throw invalidRequest('Each message must be an object.');
    if (message.role !== 'user' && message.role !== 'assistant') throw invalidRequest('Anthropic message role must be user or assistant.');
    const translated = anthropicContent(message.content);
    messages.push({
      role: message.role,
      content: translated.content,
      ...(translated.toolCalls ? { tool_calls: translated.toolCalls } : {}),
    });
  }
  const tools = anthropicTools(body.tools);
  return {
    model: body.model,
    messages,
    ...(body.stream === undefined ? {} : { stream: body.stream }),
    ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(tools === undefined ? {} : { tools }),
  };
}

/**
 * Chat completion reply → Anthropic Messages shape. Text becomes one `text` block; tool calls become
 * `tool_use` blocks. Streaming is deliberately not reframed on this route (a streamed Anthropic event
 * protocol is a separate surface); `stream: true` is refused by the handler rather than silently served
 * in the wrong shape.
 */
export function chatToMessagesBody(input: {
  id: string;
  model: string;
  createdAt: string;
  content: string;
  toolCalls?: ReadonlyArray<{ id?: string; function: { name: string; arguments: string } }>;
  usage?: { inputTokens?: number; outputTokens?: number };
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
    id: input.id,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: input.toolCalls?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    created_at: input.createdAt,
    usage: {
      input_tokens: input.usage?.inputTokens ?? 0,
      output_tokens: input.usage?.outputTokens ?? 0,
    },
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
