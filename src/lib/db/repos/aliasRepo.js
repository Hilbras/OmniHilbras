import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { invalidateAllowEntries } from "@/lib/auth/allowCache.js";
import { clearModelResolutionCache } from "@/lib/modelResolutionCache.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases(workspaceId = DEFAULT_WORKSPACE_ID) {
  return await aliasKv.getAll(workspaceId);
}

export async function setModelAlias(alias, model, workspaceId = DEFAULT_WORKSPACE_ID) {
  await aliasKv.set(alias, model, workspaceId);
  // An alias resolves to a model, so repointing one changes what an
  // allow-list entry resolves to — and what the model string routes to.
  invalidateAllowEntries();
  clearModelResolutionCache();
}

export async function deleteModelAlias(alias, workspaceId = DEFAULT_WORKSPACE_ID) {
  await aliasKv.remove(alias, workspaceId);
  invalidateAllowEntries();
  clearModelResolutionCache();
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels(workspaceId = DEFAULT_WORKSPACE_ID) {
  const all = await customKv.getAll(workspaceId);
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/transport without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, transport, origin }, workspaceId = DEFAULT_WORKSPACE_ID) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ? AND workspaceId = ?`, [k, workspaceId]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ? AND workspaceId = ?`, [stringifyJson(next), k, workspaceId]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(origin ? { origin } : {}), ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) });
    db.run(`INSERT INTO kv(scope, key, value, workspaceId) VALUES('customModels', ?, ?, ?)`, [k, value, workspaceId]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }, workspaceId = DEFAULT_WORKSPACE_ID) {
  await customKv.remove(customKey(providerAlias, id, type), workspaceId);
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName, workspaceId = DEFAULT_WORKSPACE_ID) {
  if (toolName) {
    const v = await mitmKv.get(toolName, {}, workspaceId);
    return v || {};
  }
  return await mitmKv.getAll(workspaceId);
}

export async function setMitmAliasAll(toolName, mappings, workspaceId = DEFAULT_WORKSPACE_ID) {
  await mitmKv.set(toolName, mappings || {}, workspaceId);
}