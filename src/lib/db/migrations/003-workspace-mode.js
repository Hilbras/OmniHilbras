// Workspace isolation: add workspaces table + workspaceId column to all data tables.
//
// Existing rows are backfilled with workspaceId = 'default'.
// A 'default' workspace record is seeded so the UI has something to show on
// first run after migration.
//
// The kv table's primary key changes from (scope, key) to (scope, key,
// workspaceId) — that is a destructive change SQLite cannot do with ALTER,
// so the table is rebuilt.
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";
import { TABLES } from "../schema.js";

function tableExists(db, name) {
  return db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).length > 0;
}

function columnsOf(db, table) {
  try {
    return db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  } catch {
    return [];
  }
}

function hasColumn(db, table, col) {
  return columnsOf(db, table).includes(col);
}

function backfillColumn(db, table) {
  if (!tableExists(db, table) || !hasColumn(db, table, "workspaceId")) return;
  db.run(`UPDATE ${table} SET workspaceId = 'default' WHERE workspaceId IS NULL OR workspaceId = ''`);
}

// The kv table goes from PRIMARY KEY (scope, key) to (scope, key, workspaceId).
// SQLite cannot ALTER a primary key, so the table is rebuilt.
function migrateKvTable(db) {
  if (!tableExists(db, "kv")) return;
  
  // Check if the primary key is already correct
  const indexes = db.all(`SELECT * FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kv' AND sql IS NOT NULL`);
  const hasCorrectPK = indexes.some(idx => idx.sql && idx.sql.includes('PRIMARY KEY (scope, key, workspaceId)'));
  if (hasCorrectPK) return; // already migrated
  
  // Check if workspaceId column exists
  const cols = columnsOf(db, "kv");
  if (!cols.includes("workspaceId")) {
    // Add workspaceId column first
    db.exec(`ALTER TABLE kv ADD COLUMN workspaceId TEXT NOT NULL DEFAULT 'default'`);
  }
  
  // Rebuild table with new primary key
  db.exec(`CREATE TABLE kv_new (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    workspaceId TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY (scope, key, workspaceId)
  )`);
  db.exec(`INSERT INTO kv_new (scope, key, value, workspaceId) SELECT scope, key, value, COALESCE(workspaceId, 'default') FROM kv`);
  db.exec(`DROP TABLE kv`);
  db.exec(`ALTER TABLE kv_new RENAME TO kv`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope, workspaceId)`);
  console.log("[DB][migrate] kv table rebuilt with workspaceId");
}

// Seed the default workspace if it doesn't exist.
function seedDefaultWorkspace(db) {
  if (!tableExists(db, "workspaces")) return;
  const existing = db.get(`SELECT id FROM workspaces WHERE id = ? OR slug = ?`, ["default", "default"]);
  if (existing) return;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspaces(id, name, slug, description, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    ["default", "Default Workspace", "default", "The default workspace for single-user installs", now, now]
  );
  console.log("[DB][migrate] seeded default workspace");
}

// Add workspaceId column to a table if it doesn't have it.
function addWorkspaceColumn(db, table) {
  if (!tableExists(db, table)) return;
  if (hasColumn(db, table, "workspaceId")) return;

  const def = TABLES[table];
  if (!def) return;

  const workspaceColDef = def.columns.workspaceId;
  if (!workspaceColDef) return;

  // Strip PRIMARY KEY / UNIQUE for ALTER TABLE compatibility
  const safeDef = workspaceColDef
    .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
    .replace(/UNIQUE/i, "")
    .trim();

  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN workspaceId ${safeDef}`);
    console.log(`[DB][migrate] +column ${table}.workspaceId`);
  } catch (e) {
    console.warn(`[DB][migrate] add workspaceId to ${table} failed: ${e.message}`);
  }
}

export default {
  version: 3,
  name: "workspace-mode",
  up(db) {
    // Defer the TABLES import to avoid a circular reference at module load.
    const { TABLES } = require("../schema.js");

    // 1. Create workspaces table
    if (!tableExists(db, "workspaces")) {
      const cols = Object.entries(TABLES.workspaces.columns).map(([k, v]) => `${k} ${v}`);
      db.exec(`CREATE TABLE IF NOT EXISTS workspaces (${cols.join(", ")})`);
      for (const idx of TABLES.workspaces.indexes || []) {
        db.exec(idx);
      }
      console.log("[DB][migrate] created workspaces table");
    }

    // 2. Add workspaceId to all data tables
    for (const table of ["providerConnections", "providerNodes", "proxyPools", "combos", "apiKeys", "usageHistory", "requestDetails"]) {
      addWorkspaceColumn(db, table);
    }

    // 3. Migrate kv table (special: rebuild for new PK)
    migrateKvTable(db);

    // 4. Backfill existing rows
    for (const table of ["providerConnections", "providerNodes", "proxyPools", "combos", "usageHistory", "requestDetails"]) {
      backfillColumn(db, table);
    }

    // 5. apiKeys: workspaceId is nullable (backward-compat = all workspaces)
    //    No backfill needed — existing keys keep null = unrestricted.

    // 6. Seed default workspace
    seedDefaultWorkspace(db);
  },
};
