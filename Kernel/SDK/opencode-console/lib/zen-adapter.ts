import { ZEN_FINGERPRINT_TOOL_NAMES, zenFingerprintTools } from './zen-free-tier.js';
import type { ToolDefinition } from './types.js';

/**
 * The gated free-tier tool contract, shared with OpenCode Console.
 *
 * This file used to also carry a `ZenAdapter` — a full second copy of the adapter in
 * `Kernel/SDK/zen/adapter/index.ts`, with one difference (the org header). The gateway imports the
 * real adapter, so a fix applied to that copy was inert; the org-header fix landed there and shipped
 * as a release note before anyone noticed. Only the shared tool shaping remains.
 */

/** A tool in the shape the upstream expects. */
function toGatedTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters },
  };
}

export function gatedTools(tools: readonly ToolDefinition[] | undefined) {
  const quartet = new Set<string>(ZEN_FINGERPRINT_TOOL_NAMES);
  const seen = new Set<string>();
  const out: ReturnType<typeof toGatedTool>[] = [];
  for (const tool of tools ?? []) {
    const lower = tool.name.trim().toLowerCase();
    const name = quartet.has(lower) ? lower : tool.name;
    if (quartet.has(lower)) {
      if (seen.has(lower)) continue;
      seen.add(lower);
    }
    out.push(toGatedTool({ ...tool, name }));
  }
  for (const name of ZEN_FINGERPRINT_TOOL_NAMES) {
    if (!seen.has(name)) out.push(...zenFingerprintTools().filter((tool) => tool.function.name === name));
  }
  return out;
}
