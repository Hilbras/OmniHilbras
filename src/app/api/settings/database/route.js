import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/lib/auth/cliToken";

const PASSWORD_HEADER = "x-9r-password";

// A CLI-token request is already trusted (local machine); skip password
// re-auth.
//
// The token's *value* is checked, not the presence of the header. Checking
// only the presence meant any dashboard session could add
// `x-9r-cli-token: x` and download a full plaintext secret dump without
// knowing the dashboard password — which is exactly what the re-auth exists
// to prevent.
function isCliRequest(request) {
  return hasValidCliToken(request);
}

export async function GET(request) {
  try {
    if (!isCliRequest(request) && !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const payload = await exportDb();
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { password, ...payload } = await request.json();
    if (!isCliRequest(request) && !(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    await importDb(payload);

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
