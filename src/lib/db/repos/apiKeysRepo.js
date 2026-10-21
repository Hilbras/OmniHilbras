import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import { hashApiKey } from "@/lib/auth/keyPepper.js";
import { isInternalApiKey } from "@/lib/auth/internalKey.js";
import { invalidateKeyRows, lookupKeyRow, storeKeyRow } from "@/lib/auth/apiKeyCache.js";
import { maskApiKey } from "../helpers/maskApiKey.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    // The column holds the display form, never the secret. A row written
    // before the key hash existed still holds the plaintext until it is
    // healed — it must not hand that out either.
    key: maskApiKey(row.key),
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

/**
 * The row of a presented key.
 *
 * The hash is what identifies a key. A row written before the hash existed
 * still holds its plaintext and is matched by it — that is the dual-read
 * window — and is healed right after, so the plaintext does not stay in the
 * row.
 */
function findRow(db, key) {
  const hashed = db.get(`SELECT * FROM apiKeys WHERE keyHash = ?`, [hashApiKey(key)]);
  if (hashed) return { row: hashed, legacy: false };
  // Only a row without a hash may be matched by its plaintext: a healed row
  // must never be re-bound to a key that merely looks like its display form.
  const legacy = db.get(`SELECT * FROM apiKeys WHERE key = ? AND keyHash IS NULL`, [key]);
  if (legacy) return { row: legacy, legacy: true };
  return null;
}

// Replace the plaintext of a legacy row with its hash and its display form.
function healRow(db, row, key) {
  const keyHash = hashApiKey(key);
  const masked = maskApiKey(key);
  try {
    db.transaction(() => {
      db.run(`UPDATE apiKeys SET keyHash = ?, key = ? WHERE id = ?`, [keyHash, masked, row.id]);
      // SQLite keeps the bytes of the page it freed, so the file still
      // carries the key until the database is compacted. Ask for that at the
      // next boot — a VACUUM here would block the request that healed the key.
      db.run(`INSERT INTO _meta(key, value) VALUES ('needsCompaction', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`);
    });
  } catch (e) {
    // A failed heal must not lock the key out: the row keeps its plaintext
    // and stays findable through the legacy lookup.
    console.warn(`[apiKeys] could not hash key ${row.id}: ${e.message}`);
    return row;
  }
  return { ...row, keyHash, key: masked };
}

// The row of a presented key, healed when it is a legacy row.
function resolveRow(db, key) {
  const found = findRow(db, key);
  if (!found) return null;
  return found.legacy ? healRow(db, found.row, key) : found.row;
}

// The row of a presented key, from the cache when it is still there.
//
// The lookup is the same for every request of the same key, so the row is
// kept (keyed by the hash of the presented key) and the database is read
// again only when the key table changes or the entry ages out.
async function resolveCachedRow(db, key) {
  const keyHash = hashApiKey(key);
  const cached = lookupKeyRow(keyHash);
  if (cached !== undefined) return cached;
  const row = resolveRow(db, key);
  storeKeyRow(keyHash, row);
  return row;
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  return rowToKey(await resolveCachedRow(db, key));
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    // The plaintext: returned to the caller once and never stored. The row
    // keeps the display form and the hash.
    key: result.key,
    keyHash: hashApiKey(result.key),
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, keyHash, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, maskApiKey(result.key), apiKey.keyHash, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
  );
  // A key that was just created must be found by the next request.
  invalidateKeyRows();
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    // The key column is not written: it holds the display form of a secret
    // the database does not have, so it cannot be set from here.
    db.run(
      `UPDATE apiKeys SET name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  // The row changed: its name, its active flag, its allow list. A cached copy
  // of it must not outlive the change — a paused key has to stop working and a
  // new allow list has to take effect on the next request.
  invalidateKeyRows();
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  invalidateKeyRows();
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  if (!key) return false;
  const db = await getAdapter();
  const row = await resolveCachedRow(db, key);
  if (!row) {
    // The app's own key: derived from the local pepper, never in the database.
    return isInternalApiKey(key);
  }
  return row.isActive === 1 || row.isActive === true;
}
