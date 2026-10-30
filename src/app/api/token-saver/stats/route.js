import { NextResponse } from "next/server";
import { getTokenSaverStats } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

/**
 * GET /api/token-saver/stats?period=7d
 *
 * What the savers actually saved: bytes and estimated tokens per saver,
 * per-provider attribution, and the provider's own cache figures. Backed by
 * the `meta` blob each request now records (open-sse/rtk/telemetry.js).
 *
 * `requestsWithTelemetry` vs `requests` tells the caller how much of the
 * period predates telemetry — those rows cannot be counted either way.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const stats = await getTokenSaverStats(period);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get token saver stats:", error);
    return NextResponse.json({ error: "Failed to fetch token saver stats" }, { status: 500 });
  }
}
