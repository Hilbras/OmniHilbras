import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { invalidateAllowEntries, invalidateComboNames } from "@/lib/auth/allowCache.js";
import { clearModelResolutionCache } from "@/lib/modelResolutionCache.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

// A combo is named by an allow list and shadows a model alias of the same
// name, so a change to one changes what the allow lists resolve to — and what
// a bare model string routes to.
function invalidateComboCaches() {
  invalidateComboNames();
  invalidateAllowEntries();
  clearModelResolutionCache();
}

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspaceId: row.workspaceId || DEFAULT_WORKSPACE_ID,
  };
}

export async function getCombos(workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos WHERE workspaceId = ? ORDER BY createdAt ASC`, [workspaceId]);
  return rows.map(rowToCombo);
}

export async function getComboById(id, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
  return rowToCombo(row);
}

export async function getComboByName(name, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ? AND workspaceId = ?`, [name, workspaceId]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
    workspaceId: data.workspaceId || DEFAULT_WORKSPACE_ID,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt, workspaceId) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt, combo.workspaceId]
  );
  invalidateComboCaches();
  return combo;
}

export async function updateCombo(id, data, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ?, workspaceId = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, merged.workspaceId, id]
    );
    result = merged;
  });
  invalidateComboCaches();
  return result;
}

export async function deleteCombo(id, workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
  invalidateComboCaches();
  return (res?.changes ?? 0) > 0;
}