import { NextResponse } from "next/server";
import { getRateLimitStatus } from "@/sse/services/rateLimit.js";

// What the client-facing limits have been doing: what each identity spent in
// the last minute, what it was allowed, and how often it was turned away.
//
// The route inherits its authentication from the dashboard guard (deny by
// default for everything under /api/ that is not public) — it must not be
// added to the public list: the response names the keys that are calling.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getRateLimitStatus());
  } catch (error) {
    console.error("[API] Failed to get rate limit status:", error);
    return NextResponse.json({ error: "Failed to fetch rate limit status" }, { status: 500 });
  }
}
