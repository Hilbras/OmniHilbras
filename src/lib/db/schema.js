// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 3;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  workspaces: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      slug: "TEXT UNIQUE NOT NULL",
      description: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ws_slug ON workspaces(slug)",
    ],
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
      "CREATE INDEX IF NOT EXISTS idx_pc_workspace ON providerConnections(workspaceId)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)",
      "CREATE INDEX IF NOT EXISTS idx_pn_workspace ON providerNodes(workspaceId)",
    ],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
      "CREATE INDEX IF NOT EXISTS idx_pp_workspace ON proxyPools(workspaceId)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      // The display form of the key, not the secret: the plaintext is shown
      // once (in the response to the key's creation) and never stored, so
      // this column can repeat — two keys may share a display form. The
      // uniqueness that matters lives on keyHash.
      key: "TEXT NOT NULL",
      // sha256(pepper || key). The pepper is a per-install secret in its own
      // 0600 file, so a stolen database holds no usable credential.
      keyHash: "TEXT",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Per-key access control. Additive columns, picked up by
      // syncSchemaFromTables() on boot; existing rows read as unrestricted (0).
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
      // Null = no workspace scope (backward-compat, all workspaces).
      // Otherwise points at workspaces.id.
      workspaceId: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_key_hash ON apiKeys(keyHash)",
      "CREATE INDEX IF NOT EXISTS idx_ak_workspace ON apiKeys(workspaceId)",
    ],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)",
      "CREATE INDEX IF NOT EXISTS idx_combo_workspace ON combos(workspaceId)",
    ],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    primaryKey: "PRIMARY KEY (scope, key, workspaceId)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope, workspaceId)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_workspace ON usageHistory(workspaceId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT",
      data: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    primaryKey: "PRIMARY KEY (dateKey, workspaceId)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ud_ws ON usageDaily(workspaceId)",
    ],
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT 'default'",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_rd_workspace ON requestDetails(workspaceId)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
