import { NextResponse } from "next/server";
import { getRequestLogDetailById, deleteRequestLogById } from "@/lib/requestDetailsDb";
import { redactPayloads } from "@/lib/observability/logQuery";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { id } = await params;
  try {
    const detail = await getRequestLogDetailById(id);
    if (!detail) return NextResponse.json({ error: "Log entry not found" }, { status: 404 });
    return NextResponse.json(redactPayloads(detail));
  } catch (error) {
    console.error("[API] Failed to get observability log:", error);
    return NextResponse.json({ error: "Failed to fetch log entry" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  try {
    const deleted = await deleteRequestLogById(id);
    if (!deleted) return NextResponse.json({ error: "Log entry not found" }, { status: 404 });
    return NextResponse.json({ deleted: 1 });
  } catch (error) {
    console.error("[API] Failed to delete observability log:", error);
    return NextResponse.json({ error: "Failed to delete log entry" }, { status: 500 });
  }
}
