// GET /api/workspaces - List all workspaces
// POST /api/workspaces - Create a new workspace
import { NextResponse } from "next/server";
import { getAllWorkspaces, createWorkspace } from "@/lib/db/repos/workspacesRepo.js";

export async function GET(request) {
  try {
    const workspaces = await getAllWorkspaces();
    return NextResponse.json({ workspaces });
  } catch (error) {
    console.log("Error listing workspaces:", error);
    return NextResponse.json({ error: "Failed to list workspaces" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const workspace = await createWorkspace(body);
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    console.log("Error creating workspace:", error);
    const msg = error.message || "Failed to create workspace";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}