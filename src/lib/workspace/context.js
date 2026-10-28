// Workspace context resolution.
//
// Single source of truth for "which workspace is the current request in?"
// Two callers:
//   1. API-key auth path (/v1/*) — the key carries its workspaceId.
//   2. Dashboard (session) — read from settings.currentWorkspace.
//
// Both fall back to 'default' when no workspace is configured.

import { getAdapter } from "../db/driver.js";
import { getSettings } from "../db/repos/settingsRepo.js";
import { getCachedWorkspaceById, storeWorkspaceCache } from "./workspaceCache.js";

const DEFAULT_WORKSPACE = "default";

/**
 * Resolve the workspace ID from an API key.
 * Keys with no workspaceId (legacy) get DEFAULT_WORKSPACE — preserves backward
 * compatibility so existing installs keep working.
 */
export async function resolveWorkspaceForKey(keyHash) {
  if (!keyHash) return DEFAULT_WORKSPACE;
  const db = await getAdapter();
  const row = db.get(
    `SELECT workspaceId FROM apiKeys WHERE keyHash = ? AND isActive = 1`,
    [keyHash],
  );
  if (!row) return null; // unknown key
  return row.workspaceId || DEFAULT_WORKSPACE;
}

/**
 * Get the current workspace for dashboard requests (no API key).
 * Reads settings.currentWorkspace, falling back to 'default'.
 */
export async function getCurrentWorkspaceId() {
  const settings = await getSettings();
  return settings.currentWorkspace || DEFAULT_WORKSPACE;
}

/**
 * Resolve workspace from a Next.js Request — checks API key header first,
 * then dashboard context.
 */
export async function resolveWorkspaceForRequest(request) {
  // 1. Try API key from x-api-key header
  const rawKey = request?.headers?.get?.("x-api-key");
  if (rawKey) {
    const { hashApiKey } = await import("@/lib/auth/keyPepper.js");
    const hash = hashApiKey(rawKey);
    const ws = await resolveWorkspaceForKey(hash);
    if (ws) return ws;
  }

  // 2. Dashboard / session path — read from settings
  return getCurrentWorkspaceId();
}

/**
 * Get workspace metadata by ID.
 */
export async function getWorkspaceById(workspaceId = DEFAULT_WORKSPACE) {
  const cached = getCachedWorkspaceById(workspaceId);
  if (cached) return cached;

  const db = await getAdapter();
  const row = db.get(
    `SELECT id, name, slug, description, createdAt, updatedAt FROM workspaces WHERE id = ?`,
    [workspaceId],
  );
  if (row) {
    storeWorkspaceCache(workspaceId, row);
    return row;
  }
  return null;
}

/**
 * List all workspaces (for admin/management UI).
 */
export async function listWorkspaces() {
  const db = await getAdapter();
  return db.all(
    `SELECT id, name, slug, description, createdAt, updatedAt FROM workspaces ORDER BY name ASC`,
  );
}

export { DEFAULT_WORKSPACE };
