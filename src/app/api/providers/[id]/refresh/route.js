import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh";
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";
import { fetchZcodeBalance, invalidateLocalAuthCache as invalidateZcodeLocalAuth } from "open-sse/executors/zcode.js";
import { clearAdcodeTokenCache } from "open-sse/config/adcode.js";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/refresh - Force a full credential refresh for a
// connection, regardless of its auth scheme:
//   - OAuth / API-key / Cookie accounts → the shared force-refresh path
//     (checkAndRefreshToken force:true), persisted back to localDb
//   - noAuth desktop-credentialed providers (adcode, zcode) → clear the
//     in-memory token cache so the next use re-mints from the desktop store
//
// Returns what actually happened so the dashboard can show it plainly:
//   { refreshed: "tokens" | "cache" | "none", detail?: string }
export async function POST(request, { params }) {
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // Desktop-credentialed noAuth providers: the credential is the machine's
  // local app store, not the connection row — refresh means re-mint on next
  // use, so just clear the process caches.
  if (connection.provider === "adcode") {
    clearAdcodeTokenCache();
    return NextResponse.json({
      refreshed: "cache",
      detail: "ADCode desktop token cache cleared — the next request re-mints from the desktop client's identity store.",
    });
  }
  if (connection.provider === "zcode") {
    // The decrypted local JWT is cached keyed by the store file's mtime —
    // clearing it forces a re-read on the next request (rotation via
    // sign-out/in in the ZCode desktop app still works through the 401 path).
    invalidateZcodeLocalAuth();
    return NextResponse.json({
      refreshed: "cache",
      detail: "ZCode desktop token cache cleared — the next request re-reads the credential store.",
    });
  }

  try {
    const refreshed = await checkAndRefreshToken(connection.provider, connection, { force: true });

    if (isUnrecoverableRefreshError(refreshed)) {
      await updateProviderConnection(id, {
        testStatus: "unavailable",
        lastError: "Credential refresh failed — sign-in revoked",
        lastErrorAt: new Date().toISOString(),
      });
      return NextResponse.json({
        refreshed: "none",
        detail: "Refresh failed: the sign-in was revoked upstream (refresh token spent or account removed). Re-authorize this connection.",
      });
    }

    if (refreshed.accessToken || refreshed.apiKey || refreshed.lastRefreshAt || (refreshed.copilotToken)) {
      return NextResponse.json({
        refreshed: "tokens",
        detail: "Tokens refreshed and saved to the connection.",
      });
    }

    return NextResponse.json({
      refreshed: "none",
      detail: "No refreshable credentials on this connection — it uses the stored key/session as-is.",
    });
  } catch (error) {
    return NextResponse.json({
      refreshed: "none",
      detail: `Refresh failed: ${error?.message || error}`,
    });
  }
}
