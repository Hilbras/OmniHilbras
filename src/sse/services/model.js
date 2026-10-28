// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodeByPrefix } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import {
  readModelResolution,
  writeModelResolution,
} from "@/lib/modelResolutionCache.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias, workspaceId = "default") {
  const aliases = await getModelAliases(workspaceId);
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * The model resolution, memoised.
 *
 * See src/lib/modelResolutionCache.js — the cache itself lives there so the
 * repositories that invalidate it do not have to import this module back.
 */
export { clearModelResolutionCache } from "@/lib/modelResolutionCache.js";

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr, workspaceId = "default") {
  const key = `model:${workspaceId}:${modelStr}`;
  const cached = readModelResolution(key);
  if (cached) return { ...cached };
  return { ...(await writeModelResolution(key, await resolveModelInfo(modelStr, workspaceId))) };
}

async function resolveModelInfo(modelStr, workspaceId = "default") {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      // One query for the three node types, then one prefix match — this ran
      // per model resolution, and a resolution happens per allow-list entry
      // of a restricted key.
      const matchedNode = await getProviderNodeByPrefix(parsed.providerAlias, workspaceId);
      if (matchedNode) {
        return { provider: matchedNode.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model, workspaceId);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr, workspaceId = "default") {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const key = `combo:${workspaceId}:${modelStr}`;
  const cached = readModelResolution(key);
  if (cached !== undefined) return cached ? [...cached] : cached;

  const combo = await getComboByName(modelStr, workspaceId);
  const models = combo && combo.models && combo.models.length > 0 ? combo.models : null;
  writeModelResolution(key, models);
  return models ? [...models] : null;
}
