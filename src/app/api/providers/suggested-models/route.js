import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

/**
 * Suggested models for a provider's modelsFetcher URL.
 *
 * When `provider` is passed, the saved connection's API key is attached as
 * `Authorization: Bearer …` so gateways that require auth (most free-tier
 * aggregators) answer with their full catalogue. Without a saved key the
 * request goes out unauthenticated, which only public endpoints accept.
 *
 * Failures are reported, not swallowed: the payload carries `upstream`
 * (HTTP status from the provider) or `error` (route-level problem), so the
 * dashboard can say why nothing came back.
 */
export async function GET(request) {
  const searchParams = new URL(request.url).searchParams;
  const url = searchParams.get("url");
  const type = searchParams.get("type");
  const providerId = searchParams.get("provider");

  if (!url || !type) {
    return NextResponse.json({ data: [], error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ data: [], error: "Unknown filter type" }, { status: 400 });
  }

  // Bearer auth from THIS provider's saved connection when named.
  // getProviderConnections takes a filter object — a bare string returns every
  // connection, which attached the wrong provider's key and got 401s.
  let authHeader;
  let hasKey = false;
  if (providerId) {
    try {
      const connections = await getProviderConnections({ provider: providerId });
      const active = connections.find((c) => c.isActive !== false && (c.apiKey || c.accessToken));
      const key = active?.apiKey || active?.accessToken;
      if (key) {
        authHeader = `Bearer ${key}`;
        hasKey = true;
      }
    } catch {
      // No saved key — fall through unauthenticated.
    }
  }

  try {
    // Gemini: /v1beta/models takes the key as a query param, not a Bearer header.
    const isGemini = url.includes("generativelanguage.googleapis.com");
    const target = isGemini && hasKey ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(authHeader.slice(7))}` : url;
    const res = await fetch(target, {
      headers: authHeader && !isGemini ? { Authorization: authHeader } : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({
        data: [],
        upstream: res.status,
        error: !hasKey && providerId
          ? "No saved API key for this provider — add a connection first."
          : `Provider models endpoint answered HTTP ${res.status}.`,
      });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    // Object-shaped catalogs (minimax-code's {providers:[…]}) ride in as a
    // single-element array so every filter keeps an array input contract.
    const data = filter(Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null ? [raw] : []);
    return NextResponse.json({ data, upstream: res.status });
  } catch (err) {
    return NextResponse.json({ data: [], error: `Fetch failed: ${err?.message || "network error"}` });
  }
}
