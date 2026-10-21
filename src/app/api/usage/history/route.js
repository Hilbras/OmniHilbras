import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

// The history the dashboard shows.
//
// It used to compute the statistics over every retained day ("all"), which
// parses every day's roll-up — up to 400 of them. The period is a parameter
// now, and it is bounded by default: asking for "all" is still possible, but
// it has to be asked for.
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "30d";

    if (!VALID_PERIODS.includes(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const stats = await getUsageStats(period);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
