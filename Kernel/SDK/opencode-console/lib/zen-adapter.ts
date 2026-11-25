import type { ToolDefinition } from '@omnihilbras/sdk-shared/types';

/**
 * The gated free-tier tool contract, shared with the other OpenCode adapters.
 *
 * This file used to carry a second adapter and, after that, a local declaration of the tool quartet including
 * `bash`. The declaration now comes from the one catalog in Kernel/Tools through the gateway. What remains here is
 * only the shaping of those definitions onto the upstream's wire — no provider package declares a tool of its own.
 */

/** A tool in the shape the upstream expects. */
function toDeclaredTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters },
  };
}

export function declaredTools(tools: readonly ToolDefinition[] | undefined) {
  return (tools ?? []).map(toDeclaredTool);
}
