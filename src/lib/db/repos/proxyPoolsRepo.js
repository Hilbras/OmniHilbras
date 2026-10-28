import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspaceId: row.workspaceId || DEFAULT_WORKSPACE_ID,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, workspaceId, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
    workspaceId: workspaceId || DEFAULT_WORKSPACE_ID,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt, workspaceId)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt, workspaceId=excluded.workspaceId`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt, r.workspaceId]
  );
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  const ws = filter.workspaceId || DEFAULT_WORKSPACE_ID;
  where.push("workspaceId = ?");
  params.push(ws);
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools WHERE ${where.join(" AND ")}`;
  const list = db.all(sql, params).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPoolById(id, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ? AND workspaceId = ?`, [id, workspaceId]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
    workspaceId: data.workspaceId || DEFAULT_WORKSPACE_ID,
  };
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ? AND workspaceId = ?`, [id, data.workspaceId || DEFAULT_WORKSPACE_ID]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
  });
  return removed;
}