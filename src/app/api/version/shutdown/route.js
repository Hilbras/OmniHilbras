import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/lib/auth/cliToken";

// Shutdown app to release file locks for manual update.
// Requires CLI token or dashboard session (defense in depth — dashboardGuard
// middleware also gates ALWAYS_PROTECTED paths including this one).
export async function POST(request) {
  const token = request.cookies.get("auth_token")?.value;
  const authed = await hasValidCliToken(request) || (token && await verifyDashboardAuthToken(token));
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
