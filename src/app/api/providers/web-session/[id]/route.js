import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { webSessionDescriptor } from "@/shared/constants/webSessionProviders";

/**
 * Web-session providers — check and connect.
 *
 * POST /api/providers/web-session/[id]
 * Body: { action: "check" | "connect", credential: string }
 *
 * These providers are reached with a credential a signed-in browser holds, so
 * the flow is: paste it, ask the provider whether it means anything (check),
 * and only then store it (connect). Nothing is saved by a check.
 *
 * The per-provider logic lives in open-sse/shared/webSession/<id>.js — this
 * route is the plumbing, not a place where six providers are spelled out.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const descriptor = webSessionDescriptor(id);
    if (!descriptor) {
      return NextResponse.json({ error: `Unknown web-session provider: ${id}` }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const action = body?.action === "connect" ? "connect" : "check";
    const credential = typeof body?.credential === "string" ? body.credential : "";

    const provider = await import(`open-sse/shared/webSession/${id}.js`).catch(() => null);
    if (!provider) {
      return NextResponse.json(
        { error: `${descriptor.name} is not available in this build.` },
        { status: 501 },
      );
    }

    if (action === "check") {
      const result = await provider.checkWebSession(credential);
      return NextResponse.json(result);
    }

    const result = await provider.connectWebSession(credential);
    if (!result?.ok) {
      return NextResponse.json(
        { error: result?.error || "The provider refused the credential.", ok: false },
        { status: 400 },
      );
    }

    const connection = await createProviderConnection({
      provider: id,
      authType: "cookie",
      name: result.name || descriptor.name,
      apiKey: result.credential ?? credential,
      email: result.email || null,
      displayName: result.displayName || descriptor.name,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        email: connection.email,
      },
      models: result.models || [],
    });
  } catch (error) {
    console.log("Web-session route error:", error);
    return NextResponse.json({ error: error.message || "Request failed" }, { status: 500 });
  }
}
