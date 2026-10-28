// Zustand store for workspace selection and management.
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useWorkspaceStore = create(
  persist(
    (set, get) => ({
      currentWorkspace: "default",
      workspaces: [],

      // Fetch all workspaces
      fetchWorkspaces: async () => {
        try {
          const res = await fetch("/api/workspaces");
          if (res.ok) {
            const data = await res.json();
            set({ workspaces: data.workspaces || [] });
            // Ensure current workspace still exists
            const current = get().currentWorkspace;
            if (!data.workspaces?.find((w) => w.id === current)) {
              set({ currentWorkspace: "default" });
            }
          }
        } catch (err) {
          console.error("Failed to fetch workspaces:", err);
        }
      },

      // Switch current workspace
      switchWorkspace: (workspaceId) => {
        set({ currentWorkspace: workspaceId });
      },

      // Create a new workspace
      createWorkspace: async (data) => {
        const res = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          const result = await res.json();
          set((s) => ({ workspaces: [...s.workspaces, result.workspace] }));
          return result.workspace;
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create workspace");
      },

      // Delete a workspace
      deleteWorkspace: async (workspaceId) => {
        const res = await fetch(`/api/workspaces/${workspaceId}`, { method: "DELETE" });
        if (res.ok) {
          set((s) => ({
            workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
            currentWorkspace: s.currentWorkspace === workspaceId ? "default" : s.currentWorkspace,
          }));
          return true;
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete workspace");
      },

      // Update a workspace
      updateWorkspace: async (workspaceId, data) => {
        const res = await fetch(`/api/workspaces/${workspaceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (res.ok) {
          const result = await res.json();
          set((s) => ({
            workspaces: s.workspaces.map((w) => w.id === workspaceId ? result.workspace : w),
          }));
          return result.workspace;
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update workspace");
      },
    }),
    { name: "omnihilbras-workspace" },
  )
);
