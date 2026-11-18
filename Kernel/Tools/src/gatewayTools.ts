import type { ToolDefinition } from './types.js';

/**
 * The tools the gateway declares to a provider on behalf of the operator.
 *
 * The OpenCode free tier requires a non-empty `tools` array whose members are declared as unavailable. Each SDK
 * used to carry its own copy of that list, including a `bash` tool — a tool named after a shell, on a request that
 * can reach a model with tool calls. The list now lives here, the gateway applies it, and `bash` is gone: there is
 * no shell tool anywhere in the SDKs for a model to call or an operator to discover.
 *
 * The remaining names are preserved because the upstream compares them against its own client's fingerprint. The
 * description is part of that fingerprint too, so it is kept verbatim; it is a declaration, not an ability.
 */
export const GATEWAY_TOOL_NAMES = ['glob', 'grep', 'read'] as const;

const UNAVAILABLE = 'This tool is currently unavailable and must not be used.';

/** Providers whose free-tier lane needs the declaration. Owned here, not duplicated in three adapters. */
export const GATEWAY_TOOL_PROVIDERS = new Set(['opencode', 'opencode-go', 'opencode-console']);

export function gatewayToolDefinitions(): ToolDefinition[] {
  return GATEWAY_TOOL_NAMES.map((name) => ({
    name,
    description: UNAVAILABLE,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }));
}

/**
 * The caller's definitions first, then the gateway's where missing.
 *
 * A casing variant is folded onto the canonical lowercase name rather than added twice, which is what the adapters
 * used to do locally. A caller who asked for a forced call keeps exactly their own definitions — a generated
 * "unavailable" tool must never be the thing a forced choice selects.
 */
export function withGatewayTools(tools: readonly ToolDefinition[] | undefined, toolChoice?: string): ToolDefinition[] | undefined {
  if (toolChoice === 'required' || toolChoice === 'none') return tools ? [...tools] : undefined;
  const kept: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    const lower = tool.name.trim().toLowerCase();
    const canonical = (GATEWAY_TOOL_NAMES as readonly string[]).includes(lower) ? lower : tool.name;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    kept.push(canonical === lower ? { ...tool, name: canonical } : tool);
  }
  for (const tool of gatewayToolDefinitions()) {
    if (!seen.has(tool.name)) kept.push(tool);
  }
  return kept;
}
