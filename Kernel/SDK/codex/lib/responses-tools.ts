import type { ChatMessage, ChatRequest, ToolCallDelta } from '@omnihilbras/sdk-shared/types';

/**
 * The Responses API shapes a Codex agent turn needs.
 *
 * Kept package-local: a provider package may not import another provider's vendored machinery
 * (`tests/provider-standalone.test.js`). The shapes are OpenAI's documented ones — a function tool is
 * flat, an assistant call is a `function_call` item, and its result is a `function_call_output` item
 * keyed by `call_id`. Sending a chat-shaped tool or a `role: 'tool'` text item is a 400 on a Responses
 * endpoint, which is why neither is inferred from the chat request.
 */

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Messages as Responses input items, including both halves of a tool round. */
export function toCodexInput(messages: readonly ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.toolCallId ?? '', output: textOf(message) });
      continue;
    }
    const text = textOf(message);
    if (!text) continue;
    const type = message.role === 'assistant' ? 'output_text' : 'input_text';
    items.push({ role: message.role === 'system' ? 'developer' : message.role, content: [{ type, text }] });
  }
  return items;
}

/** Flat function definitions on the wire; the chat wire nests them under `function`. */
export function toCodexTools(request: ChatRequest): unknown[] | undefined {
  if (!request.tools?.length) return undefined;
  return request.tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  }));
}

type ResponsesEvent = {
  type?: string;
  delta?: unknown;
  output_index?: number;
  item?: { type?: string; call_id?: string; name?: string };
};

/** One tool delta from a Responses event, or `undefined` for an event that carries none. */
export function codexToolDelta(event: ResponsesEvent): ToolCallDelta | undefined {
  if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
    return {
      index: event.output_index ?? 0,
      ...(event.item.call_id ? { id: event.item.call_id } : {}),
      type: 'function' as const,
      ...(event.item.name ? { function: { name: event.item.name } } : {}),
    };
  }
  if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string' && event.delta) {
    return { index: event.output_index ?? 0, function: { arguments: event.delta } };
  }
  return undefined;
}
