/**
 * The tool contract, in neutral shapes.
 *
 * These are structural twins of the gateway's `ChatRequest`/`ChatResponse`, not imports of them: this package is
 * standalone the way `Kernel/TokenSaver` is, so it can be tested without a gateway and adopted by the desktop app or
 * an SDK without dragging the API in. A field the gateway adds does not have to exist here; a field here that the
 * gateway does not send is a bug in this file.
 */

export type ToolChoice = 'auto' | 'none' | 'required';

export type ToolDefinition = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ToolCallDelta = {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
};

export type ToolMessage = {
  role: string;
  content: unknown;
  toolCalls?: readonly ToolCall[];
  toolCallId?: string;
  /** The tool name, for a result the provider wants labelled. */
  name?: string;
  /** A failed result, which must not be compressed away by a token saver. */
  isError?: boolean;
};

export type ToolRequest = {
  tools?: readonly ToolDefinition[];
  toolChoice?: ToolChoice;
  messages?: readonly ToolMessage[];
};

export type ToolResponse = {
  message: { toolCalls?: readonly ToolCall[]; content: unknown };
  finishReason?: string;
};

/** What a request was changed by, so the caller can report it rather than guess. */
export type ToolRequestNotes = {
  /** Tools were present and removed, because this provider does not serve them. */
  stripped: boolean;
  /** `tool_choice: 'none'` was honoured by removing the definitions. */
  enforcedNone: boolean;
  /** The capability row was missing, so a conservative default was used. Never true in a released build. */
  assumed: boolean;
  providerId: string;
  /** Definitions dropped by the sanitiser, with the reason, for the caller's log. */
  dropped: readonly { name: string; reason: string }[];
};

export type NormalizedToolRequest<T extends ToolRequest> = {
  request: T;
  notes: ToolRequestNotes;
};
