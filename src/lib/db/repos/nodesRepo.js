import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { invalidateAllowEntries } from "@/lib/auth/allowCache.js";
import { clearModelResolutionCache } from "@/lib/modelResolutionCache.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspaceId: row.workspaceId || DEFAULT_WORKSPACE_ID,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, workspaceId, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
    workspaceId: workspaceId || DEFAULT_WORKSPACE_ID,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt, workspaceId=excluded.workspaceId`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt, r.workspaceId]
  );
}

export async function getProviderNodes(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  const ws = filter.workspaceId || DEFAULT_WORKSPACE_ID;
  where.push("workspaceId = ?");
  params.push(ws);
  if (filter.type) { where.push("type = ?"); params.push(filter.type); }
  const sql = `SELECT * FROM providerNodes WHERE ${where.join(" AND ")}`;
  return db.all(sql, params).map(rowToNode);
}

/**
 * The provider node that owns a model prefix, in one query.
 *
 * The resolution path used to ask for each of the three node types in turn —
 * three queries, each returning every node of that type, then a linear scan
 * for the prefix. It runs per model resolution, and a resolution happens per
 * allow-list entry of a restricted key, so it was O(nodes) several times over
 * for one request.
 */
export async function getProviderNodeByPrefix(prefix, workspaceId = DEFAULT_WORKSPACE_ID) {
  if (!prefix) return null;
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM providerNodes WHERE type IN (?, ?, ?) AND workspaceId = ?`,
    ["openai-compatible", "anthropic-compatible", "custom-embedding", workspaceId],
  );
  const match = rows.map(rowToNode).find((node) => node.prefix === prefix);
  return match || null;
}

export async function getProviderNodeById(id, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ? AND workspaceId = ?`, [id, workspaceId]));
}

export async function createProviderNode(data, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
    workspaceId: data.workspaceId || workspaceId,
  };
  upsert(db, node);
  // A node owns a model prefix, so a new or changed node changes what an
  // allow-list entry resolves to.
  invalidateAllowEntries();
  clearModelResolutionCache();
  return node;
}

export async function updateProviderNode(id, data, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
    if (!row) return;
    const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString(), workspaceId: data.workspaceId || workspaceId };
    upsert(db, merged);
    result = merged;
  });
  invalidateAllowEntries();
  clearModelResolutionCache();
  return result;
}

export async function deleteProviderNode(id, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
    if (!row) return;
    removed = rowToNode(row);
    db.run(`DELETE FROM providerNodes WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
    db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key LIKE ?`, [`${id}|%`]);
  });
  invalidateAllowEntries();
  clearModelResolutionCache();
  return removed;
}