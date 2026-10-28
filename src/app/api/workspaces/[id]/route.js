// GET /api/workspaces/[id] - Get single workspace
// PATCH /api/workspaces/[id] - Update workspace
// DELETE /api/workspaces/[id] - Delete workspace
import { NextResponse } from "next/server";
import { getWorkspaceById, updateWorkspace, deleteWorkspace } from "@/lib/db/repos/workspacesRepo.js";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const workspace = await getWorkspaceById(id);
    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    return NextResponse.json({ workspace });
  } catch (error) {
    console.log("Error fetching workspace:", error);
    return NextResponse.json({ error: "Failed to fetch workspace" }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const workspace = await updateWorkspace(id, body);
    return NextResponse.json({ workspace });
  } catch (error) {
    console.log("Error updating workspace:", error);
    const msg = error.message || "Failed to update workspace";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteWorkspace(id);
    if (!deleted) {
      return NextResponse.json({ error: "Workspace not found or could not be deleted" }, { status: 404 });
    }
    return NextResponse.json({ message: "Workspace deleted successfully" });
  } catch (error) {
    console.log("Error deleting workspace:", error);
    const msg = error.message || "Failed to delete workspace";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}