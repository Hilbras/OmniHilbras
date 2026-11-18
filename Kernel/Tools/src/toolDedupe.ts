import type { ToolDefinition } from './types.js';

/**
 * Provider-scoped tool dedupe, ported from 9router's measured rules.
 *
 * 9router found two concrete 400s: DeepSeek rejects duplicate tool names on every endpoint, and Claude clients that
 * already carry Exa/Tavily MCP must not also send the built-in `WebSearch`/`WebFetch`. Our sanitizer already drops
 * duplicate names globally; this module adds only the second rule, for Claude-family providers, and leaves every
 * other provider's definitions byte-identical.
 */

const CLAUDE_FAMILY = new Set(['anthropic', 'claude-code']);
const BUILTIN_WEB = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_fetch']);
const MCP_WEB = /^mcp__(exa|tavily|claude_in_chrome)__/i;

export type DedupeResult = { tools: ToolDefinition[]; dropped: { name: string; reason: string }[] };

export function dedupeToolDefinitions(tools: readonly ToolDefinition[] | undefined, providerId: string): DedupeResult {
  const input = tools ?? [];
  const dropped: { name: string; reason: string }[] = [];
  if (!CLAUDE_FAMILY.has(providerId)) return { tools: [...input], dropped };

  const hasMcpWeb = input.some((tool) => MCP_WEB.test(tool.name));
  if (!hasMcpWeb) return { tools: [...input], dropped };

  const kept: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const tool of input) {
    const reason = BUILTIN_WEB.has(tool.name) || /^mcp__Claude_in_Chrome__/.test(tool.name)
      ? 'an MCP web tool is already declared for this Claude client'
      : seen.has(tool.name) ? 'the same name was declared twice' : undefined;
    if (reason) {
      dropped.push({ name: tool.name, reason });
      continue;
    }
    seen.add(tool.name);
    kept.push(tool);
  }
  return { tools: kept, dropped };
}
