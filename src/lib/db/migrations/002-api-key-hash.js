// The apiKeys table stops holding usable keys.
//
// A key is stored as sha256(pepper || key) plus its display form; the
// plaintext exists only in the response to the key's creation. The usage
// tables follow the same rule, so a stolen database yields no credential.
//
// The rows that predate this migration are read in plaintext, so they are
// hashed and masked here — one pass, so no key is left in the clear.
import { maskApiKey } from "../helpers/maskApiKey.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { rewriteDayApiKeys } from "../helpers/usageKeyRows.js";
import { hashApiKey } from "@/lib/auth/keyPepper.js";

// The display form of a key. A stored value that already looks like one was
// masked without being hashed (should not happen — both are written together)
// and must not be hashed as if it were a secret.
function looksMasked(value) {
  return typeof value === "string" && value.includes("***");
}

function tableExists(db, name) {
  return db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).length > 0;
}

function columnsOf(db, table) {
  return db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
}

// The `key` column used to be UNIQUE because it held the secret. It holds the
// display form now, and two keys can share a display form, so the constraint
// moves to the hash — where it means "one row per key" again.
function rebuildApiKeys(db) {
  const target = ["id", "key", "keyHash", "name", "machineId", "isActive", "createdAt", "accessRestricted", "accessAllow"];
  // Only the columns this database actually has — an older table may predate
  // the access-control columns; they come back with their defaults.
  const existing = new Set(columnsOf(db, "apiKeys"));
  const copy = target.filter((c) => existing.has(c));

  db.exec(`CREATE TABLE apiKeys_hashed (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    keyHash TEXT,
    name TEXT,
    machineId TEXT,
    isActive INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL,
    accessRestricted INTEGER DEFAULT 0,
    accessAllow TEXT
  )`);
  db.run(`INSERT INTO apiKeys_hashed(${copy.join(", ")}) SELECT ${copy.join(", ")} FROM apiKeys`);
  db.exec(`DROP TABLE apiKeys`);
  db.exec(`ALTER TABLE apiKeys_hashed RENAME TO apiKeys`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_key_hash ON apiKeys(keyHash)`);
}

// Hash the stored keys and replace the plaintext with the display form.
function hashApiKeyRows(db) {
  for (const row of db.all(`SELECT id, key, keyHash FROM apiKeys`)) {
    if (row.keyHash) continue;
    if (looksMasked(row.key)) {
      console.warn(`[DB][migrate] apiKeys ${row.id} holds a display form without a hash — it can no longer authenticate`);
      continue;
    }
    db.run(`UPDATE apiKeys SET key = ?, keyHash = ? WHERE id = ?`, [
      maskApiKey(row.key),
      hashApiKey(row.key),
      row.id,
    ]);
  }
}

// The usage rows must hold the same identifier the key table displays, or the
// usage table resolves no row to a key name and old and new rows stop
// grouping together.
function rewriteUsageRows(db) {
  if (tableExists(db, "usageHistory")) {
    for (const row of db.all(`SELECT id, apiKey FROM usageHistory WHERE apiKey IS NOT NULL AND apiKey != ''`)) {
      const masked = maskApiKey(row.apiKey);
      if (masked && masked !== row.apiKey) {
        db.run(`UPDATE usageHistory SET apiKey = ? WHERE id = ?`, [masked, row.id]);
      }
    }
  }

  if (!tableExists(db, "usageDaily")) return;
  for (const row of db.all(`SELECT dateKey, data FROM usageDaily`)) {
    const day = parseJson(row.data, {});
    if (!rewriteDayApiKeys(day)) continue;
    db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [stringifyJson(day), row.dateKey]);
  }
}

export default {
  version: 2,
  name: "api-key-hash",
  up(db) {
    if (!tableExists(db, "apiKeys")) return;
    if (!columnsOf(db, "apiKeys").includes("keyHash")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN keyHash TEXT`);
    }
    rebuildApiKeys(db);
    hashApiKeyRows(db);
    rewriteUsageRows(db);
  },
};
