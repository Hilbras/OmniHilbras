// Workspaces repository — CRUD for the workspaces table.
import { getAdapter } from "../driver.js";
import { invalidateWorkspaceCache } from "./workspaceCache.js";
import { getCachedWorkspaceById, storeWorkspaceCache } from "@/lib/workspace/workspaceCache.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * List all workspaces.
 */
export async function getAllWorkspaces() {
  const db = await getAdapter();
  return db.all(
    `SELECT id, name, slug, description, createdAt, updatedAt FROM workspaces ORDER BY name ASC`,
  );
}

/**
 * Get a workspace by ID.
 */
export async function getWorkspaceById(workspaceId) {
  if (!workspaceId) return null;

  const cached = getCachedWorkspaceById(workspaceId);
  if (cached) return cached;

  const db = await getAdapter();
  const row = db.get(
    `SELECT id, name, slug, description, createdAt, updatedAt FROM workspaces WHERE id = ?`,
    [workspaceId],
  );
  if (row) storeWorkspaceCache(workspaceId, row);
  return row;
}

/**
 * Get a workspace by slug.
 */
export async function getWorkspaceBySlug(slug) {
  const db = await getAdapter();
  return db.get(
    `SELECT id, name, slug, description, createdAt, updatedAt FROM workspaces WHERE slug = ?`,
    [slug],
  );
}

/**
 * Create a new workspace.
 */
export async function createWorkspace(data) {
  const { v4: uuidv4 } = await import("uuid");
  const slug = (data.slug || data.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

  if (!data.name || !data.name.trim()) {
    throw new Error("Workspace name is required");
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(`Invalid workspace slug "${slug}". Must match ${SLUG_REGEX}`);
  }
  if (await getWorkspaceBySlug(slug)) {
    throw new Error(`Workspace with slug "${slug}" already exists`);
  }

  const db = await getAdapter();
  const now = new Date().toISOString();
  const workspace = {
    id: uuidv4(),
    name: data.name.trim(),
    slug,
    description: data.description || "",
    createdAt: now,
    updatedAt: now,
  };

  db.run(
    `INSERT INTO workspaces(id, name, slug, description, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [workspace.id, workspace.name, workspace.slug, workspace.description, workspace.createdAt, workspace.updatedAt],
  );

  return { ...workspace };
}

/**
 * Update a workspace.
 */
export async function updateWorkspace(workspaceId, data) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    throw new Error("Cannot modify the default workspace");
  }

  const db = await getAdapter();
  const now = new Date().toISOString();

  const updated = {
    name: data.name?.trim(),
    slug: data.slug,
    description: data.description,
    updatedAt: now,
  };

  // Build dynamic update
  const sets = [];
  const params = [];
  if (updated.name) { sets.push("name = ?"); params.push(updated.name); }
  if (updated.slug) {
    const slug = updated.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!SLUG_REGEX.test(slug)) {
      throw new Error(`Invalid workspace slug "${slug}". Must match ${SLUG_REGEX}`);
    }
    if (await getWorkspaceBySlug(slug) && (await getWorkspaceBySlug(slug))?.id !== workspaceId) {
      throw new Error(`Workspace with slug "${slug}" already exists`);
    }
    sets.push("slug = ?"); params.push(slug);
  }
  if (updated.description !== undefined) { sets.push("description = ?"); params.push(updated.description || ""); }
  if (sets.length === 0) return await getWorkspaceById(workspaceId);

  sets.push("updatedAt = ?");
  params.push(now);
  params.push(workspaceId);

  db.run(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`, [...params, workspaceId]);
  invalidateWorkspaceCache(workspaceId);
  return await getWorkspaceById(workspaceId);
}

/**
 * Delete a workspace.
 * Throws if the workspace has data or is the default.
 */
export async function deleteWorkspace(workspaceId) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    throw new Error("Cannot delete the default workspace");
  }

  const db = await getAdapter();

  // Check for associated data
  const hasConnections = db.get(`SELECT COUNT(*) as c FROM providerConnections WHERE workspaceId = ?`, [workspaceId]);
  if (hasConnections.c > 0) {
    throw new Error("Cannot delete workspace with provider connections. Reassign or delete them first.");
  }

  const hasKeys = db.get(`SELECT COUNT(*) as c FROM apiKeys WHERE workspaceId = ?`, [workspaceId]);
  if (hasKeys.c > 0) {
    throw new Error("Cannot delete workspace with API keys. Reassign or delete them first.");
  }

  const hasCombos = db.get(`SELECT COUNT(*) as c FROM combos WHERE workspaceId = ?`, [workspaceId]);
  if (hasCombos.c > 0) {
    throw new Error("Cannot delete workspace with combos. Reassign or delete them first.");
  }

  const res = db.run(`DELETE FROM workspaces WHERE id = ?`, [workspaceId]);
  invalidateWorkspaceCache(workspaceId);
  return (res?.changes ?? 0) > 0;
}
