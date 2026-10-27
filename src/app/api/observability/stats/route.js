import { NextResponse } from "next/server";
import { getObservabilityStats } from "@/lib/requestDetailsDb";

export const dynamic = "force-dynamic";

const PERIODS = new Set(["24h", "7d", "30d", "all"]);

/**
 * GET /api/observability/stats?period=24h|7d|30d|all
 */
export async function GET(request) {
  const period = new URL(request.url).searchParams.get("period") || "24h";
  if (!PERIODS.has(period)) {
    return NextResponse.json({ error: "period must be one of 24h, 7d, 30d, all" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getObservabilityStats(period));
  } catch (error) {
    console.error("[API] Failed to get observability stats:", error);
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 });
  }
}
