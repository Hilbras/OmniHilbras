"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input } from "@/shared/components";
import { ConfirmModal } from "@/shared/components/Modal";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { Plus, Trash2, Edit, Copy, Key } from "lucide-react";
import { cn } from "@/shared/utils/cn";

const DEFAULT_WORKSPACE_ID = "default";

export default function WorkspacesPage() {
  const { currentWorkspace, workspaces, fetchWorkspaces, switchWorkspace, createWorkspace, updateWorkspace, deleteWorkspace } = useWorkspaceStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editingWs, setEditingWs] = useState(null);
  const [newName, setNewName] = useState("");
  const [editName, setEditName] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim() || !actionLoading === false) return;
    setActionLoading(true);
    try {
      await createWorkspace({ name: newName.trim() });
      await fetchWorkspaces();
      setShowCreate(false);
      setNewName("");
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    setActionLoading(true);
    try {
      await updateWorkspace(editingWs.id, { name: editName.trim() });
      await fetchWorkspaces();
      setEditingWs(null);
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setActionLoading(true);
    try {
      await deleteWorkspace(deleteConfirm.id);
      await fetchWorkspaces();
      if (currentWorkspace === deleteConfirm.id) switchWorkspace(DEFAULT_WORKSPACE_ID);
      setDeleteConfirm(null);
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-main">Workspaces</h1>
          <p className="text-sm text-text-muted mt-1">
            Create isolated workspaces to separate providers, connections, and API keys per team or project.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          New Workspace
        </Button>
      </div>

      {/* Current workspace indicator */}
      <Card className="p-4 border border-gold/20 bg-gold-soft/10">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-gold/30 bg-gold-soft text-xs font-bold text-gold-text">
            {workspaces.find((w) => w.id === currentWorkspace)?.name?.[0]?.toUpperCase() || "D"}
          </span>
          <div>
            <p className="text-sm font-semibold text-text-main">
              Active Workspace: {workspaces.find((w) => w.id === currentWorkspace)?.name || "default"}
            </p>
            <p className="text-xs text-text-muted">
              Data in this workspace is isolated from other workspaces.
            </p>
          </div>
        </div>
      </Card>

      {/* Workspace list */}
      <Card>
        <div className="p-4 border-b border-line">
          <h2 className="text-lg font-semibold text-text-main">All Workspaces</h2>
        </div>
        <div className="p-2">
          {workspaces.length === 0 ? (
            <p className="text-sm text-text-muted p-4">No workspaces found.</p>
          ) : (
            workspaces.map((ws) => (
              <div
                key={ws.id}
                className={cn(
                  "flex items-center justify-between rounded-lg p-3 text-sm transition-colors",
                  currentWorkspace === ws.id
                    ? "bg-gold-soft/10 border border-gold/20"
                    : "hover:bg-surface"
                )}
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-gold/20 bg-gold-soft text-[10px] font-bold text-gold-text">
                    {ws.name?.[0]?.toUpperCase() || "W"}
                  </span>
                  <div>
                    <p className="font-medium text-text-main">{ws.name}</p>
                    <p className="text-xs text-text-muted">/{ws.slug}</p>
                  </div>
                  {ws.id === DEFAULT_WORKSPACE_ID && (
                    <span className="text-[10px] font-semibold text-gold-text bg-gold-soft/20 px-2 py-0.5 rounded">
                      Default
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {ws.id === DEFAULT_WORKSPACE_ID ? (
                    <button
                      onClick={() => switchWorkspace(ws.id)}
                      className="btn-gold !px-2 !py-1 !text-xs"
                    >
                      Switch
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => switchWorkspace(ws.id)}
                        className={cn(
                          "px-2 py-1 text-xs rounded",
                          currentWorkspace === ws.id
                            ? "bg-gold-soft text-gold-text"
                            : "text-text-muted hover:bg-surface"
                        )}
                      >
                        Switch
                      </button>
                      <button
                        onClick={() => { setEditingWs(ws); setEditName(ws.name); }}
                        className="p-1 text-text-muted hover:bg-surface rounded"
                        title="Edit"
                      >
                        <Edit className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(ws)}
                        className="p-1 text-text-muted hover:bg-surface rounded"
                        title="Delete"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Create modal */}
      {showCreate && (
        <Modal
          isOpen={showCreate}
          onClose={() => { setShowCreate(false); setNewName(""); }}
          title="Create Workspace"
        >
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1">Name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Marketing Team"
                autoFocus
              />
              <p className="text-xs text-text-muted mt-1">
                The slug is auto-generated from the name.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="secondary" onClick={() => { setShowCreate(false); setNewName(""); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newName.trim() || actionLoading} className="btn-gold">
                {actionLoading ? "Creating…" : "Create Workspace"}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit modal */}
      {editingWs && (
        <Modal
          isOpen={!!editingWs}
          onClose={() => setEditingWs(null)}
          title="Edit Workspace"
        >
          <form onSubmit={handleUpdate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1">Name</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="secondary" onClick={() => setEditingWs(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!editName.trim() || actionLoading}>
                {actionLoading ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <ConfirmModal
          isOpen={!!deleteConfirm}
          onClose={() => setDeleteConfirm(null)}
          onConfirm={handleDelete}
          title="Delete Workspace"
          message={`Are you sure you want to delete "${deleteConfirm.name}"? This will permanently delete all connections, API keys, and combos in this workspace. This cannot be undone.`}
          confirmText="Delete Workspace"
          cancelText="Cancel"
          variant="danger"
        />
      )}
    </div>
  );
}