import { NextResponse } from "next/server";
import {
  getRequestLogEntries, getDistinctProviders, getDistinctModels, getDistinctConnections,
  deleteRequestLogBatch, deleteRequestLogsBefore, clearAllRequestLogs,
} from "@/lib/requestDetailsDb";
import { parseLogFilter, redactPayloads } from "@/lib/observability/logQuery";

export const dynamic = "force-dynamic";

/**
 * GET /api/observability/logs
 * Query: provider, model, connectionId, status, startDate, endDate, page, pageSize (1-100)
 * Also returns the distinct filter values so the UI can fill its dropdowns in one call.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "50", 10);
  if (!Number.isInteger(page) || page < 1) {
    return NextResponse.json({ error: "page must be >= 1" }, { status: 400 });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return NextResponse.json({ error: "pageSize must be between 1 and 100" }, { status: 400 });
  }
  const { filter, error } = parseLogFilter(searchParams);
  if (error) return NextResponse.json({ error }, { status: 400 });

  try {
    const [result, providers, models, connections] = await Promise.all([
      getRequestLogEntries({ ...filter, page, pageSize }),
      getDistinctProviders(),
      getDistinctModels(),
      getDistinctConnections(),
    ]);
    return NextResponse.json({
      ...result,
      details: result.details.map(redactPayloads),
      facets: { providers, models, connections },
    });
  } catch (err) {
    console.error("[API] Failed to get observability logs:", err);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}

/**
 * DELETE /api/observability/logs
 * Body: { ids: string[] } | { before: <date> } | { all: true }
 */
export async function DELETE(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    let deleted;
    if (Array.isArray(body.ids)) {
      if (!body.ids.every((id) => typeof id === "string")) {
        return NextResponse.json({ error: "ids must be strings" }, { status: 400 });
      }
      deleted = await deleteRequestLogBatch(body.ids);
    } else if (body.before !== undefined) {
      if (Number.isNaN(new Date(body.before).getTime())) {
        return NextResponse.json({ error: "before is not a valid date" }, { status: 400 });
      }
      deleted = await deleteRequestLogsBefore(body.before);
    } else if (body.all === true) {
      deleted = await clearAllRequestLogs();
    } else {
      return NextResponse.json({ error: "Provide ids, before, or all: true" }, { status: 400 });
    }
    return NextResponse.json({ deleted });
  } catch (err) {
    console.error("[API] Failed to delete observability logs:", err);
    return NextResponse.json({ error: "Failed to delete logs" }, { status: 500 });
  }
}
