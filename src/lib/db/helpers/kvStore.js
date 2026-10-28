import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "./jsonCol.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

export function makeKv(scope) {
  return {
    async get(key, fallback = null, workspaceId = DEFAULT_WORKSPACE_ID) {
      const db = await getAdapter();
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ? AND workspaceId = ?`, [scope, key, workspaceId]);
      return row ? parseJson(row.value, fallback) : fallback;
    },
    async getAll(workspaceId = DEFAULT_WORKSPACE_ID) {
      const db = await getAdapter();
      const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? AND workspaceId = ?`, [scope, workspaceId]);
      const out = {};
      for (const r of rows) out[r.key] = parseJson(r.value);
      return out;
    },
    async set(key, value, workspaceId = DEFAULT_WORKSPACE_ID) {
      const db = await getAdapter();
      db.run(`INSERT INTO kv(scope, key, value, workspaceId) VALUES(?, ?, ?, ?) ON CONFLICT(scope, key, workspaceId) DO UPDATE SET value = excluded.value`, [scope, key, stringifyJson(value), workspaceId]);
    },
    async setMany(obj, workspaceId = DEFAULT_WORKSPACE_ID) {
      const db = await getAdapter();
      db.transaction(() => {
        for (const [k, v] of Object.entries(obj)) {
          db.run(`INSERT INTO kv(scope, key, value, workspaceId) VALUES(?, ?, ?, ?) ON CONFLICT(scope, key, workspaceId) DO UPDATE SET value = excluded.value`, [scope, k, stringifyJson(v), workspaceId]);
        }
      });
    },
    async remove(key, workspaceId = DEFAULT_WORKSPACE_ID) {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ? AND workspaceId = ?`, [scope, key, workspaceId]);
    },
    async clear(workspaceId = DEFAULT_WORKSPACE_ID) {
      const db = await getAdapter();
      db.run(`DELETE FROM kv WHERE scope = ? AND workspaceId = ?`, [scope, workspaceId]);
    },
  };
}