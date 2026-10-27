import { getRequestLogEntries } from "@/lib/requestDetailsDb";
import { parseLogFilter, redactPayloads, toCsv, toJsonl } from "@/lib/observability/logQuery";

export const dynamic = "force-dynamic";

// The log is capped at observabilityMaxRecords (≤ 100000), so one bounded read covers it.
const EXPORT_LIMIT = 100000;

function jsonError(message, status) {
  return Response.json({ error: message }, { status });
}

/**
 * POST /api/observability/export
 * Body: { format: "jsonl" | "csv", ...filter }
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const format = body.format || "jsonl";
  if (format !== "jsonl" && format !== "csv") {
    return jsonError("format must be jsonl or csv", 400);
  }
  const { filter, error } = parseLogFilter(body);
  if (error) return jsonError(error, 400);

  try {
    const { details } = await getRequestLogEntries({ ...filter, page: 1, pageSize: EXPORT_LIMIT });
    const rows = details.map(redactPayloads);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const content = format === "csv" ? toCsv(rows) : toJsonl(rows);
    return new Response(content, {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="observability-${stamp}.${format}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[API] Failed to export observability logs:", err);
    return jsonError("Failed to export logs", 500);
  }
}
