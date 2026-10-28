import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

// One row per installed skill: { id, sha256, installedAt, updatedAt }.
// The SKILL.md itself lives on disk (see src/lib/skills/skillStore.js).
const SCOPE = "installedSkills";

export async function getInstalledSkills() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? ORDER BY key ASC`, [SCOPE]);
  return rows.map((r) => ({ id: r.key, ...parseJson(r.value, {}) }));
}

export async function getInstalledSkill(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
  return row ? { id, ...parseJson(row.value, {}) } : null;
}

export async function saveInstalledSkill(id, record) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, workspaceId, value) VALUES(?, ?, ?, ?) ON CONFLICT(scope, key, workspaceId) DO UPDATE SET value = excluded.value`,
    [SCOPE, id, DEFAULT_WORKSPACE_ID, stringifyJson(record)]
  );
}

export async function deleteInstalledSkill(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, id]);
  return (res?.changes ?? 0) > 0;
}
