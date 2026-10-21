import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";
const DEFAULT_MAX_TOKENS = 1024;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

export const dynamic = "force-dynamic";

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    // Prefer an unrestricted key so a dashboard chat is not refused just
    // because the first key happens to be restricted.
    const activeKeys = (Array.isArray(keys) ? keys : []).filter((k) => k.isActive !== false);
    apiKey = (activeKeys.find((k) => !k.access?.restricted) || activeKeys[0])?.key || null;
  } catch {}

  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

// The provider's own words, whatever shape they arrive in.
function pickUpstreamMessage(rawText, parsed) {
  const candidate = parsed?.error?.message
    || parsed?.error?.msg
    || parsed?.error
    || parsed?.msg
    || parsed?.message
    || rawText;

  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if (candidate && typeof candidate === "object") {
    try {
      return JSON.stringify(candidate);
    } catch {
      return rawText;
    }
  }
  return rawText || "The provider did not say why.";
}

// POST /api/models/chat - Stream a chat turn from one of a provider's models.
export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", status: 400 }, { status: 400 });
  }

  const { model, messages, maxTokens } = payload || {};
  if (typeof model !== "string" || !model.includes("/")) {
    return NextResponse.json(
      { error: 'model must look like "<providerAlias>/<modelId>"', status: 400 },
      { status: 400 },
    );
  }

  const history = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && ALLOWED_ROLES.has(message.role) && typeof message.content === "string")
    .map((message) => ({ role: message.role, content: message.content }));
  if (history.length === 0) {
    return NextResponse.json({ error: "messages are required", status: 400 }, { status: 400 });
  }

  const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
  const headers = await getInternalHeaders();

  // A client that hangs up (closed tab, "Stop") must take the upstream call
  // down with it — otherwise the provider keeps generating an answer nobody
  // will ever read.
  const abortController = new AbortController();
  const abortUpstream = () => abortController.abort();
  if (request.signal) {
    if (request.signal.aborted) abortController.abort();
    else request.signal.addEventListener("abort", abortUpstream, { once: true });
  }

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: history,
        max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS,
        stream: true,
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      // The browser is gone; there is nobody left to answer.
      return new Response(null, { status: 499 });
    }
    return NextResponse.json(
      { error: error?.message || "Could not reach the model gateway", status: 502 },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const rawText = await upstream.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}
    return NextResponse.json(
      { error: pickUpstreamMessage(rawText, parsed), status: upstream.status },
      { status: upstream.status },
    );
  }

  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return NextResponse.json(
      { error: "The provider returned an empty response", status: 502 },
      { status: 502 },
    );
  }

  // Hand the upstream bytes straight through — buffering them would defeat the
  // point of the chat, which is to watch the answer arrive as it is produced.
  const reader = upstreamBody.getReader();
  const stream = new ReadableStream({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          streamController.close();
          return;
        }
        if (value) streamController.enqueue(value);
      } catch (error) {
        streamController.error(error);
      }
    },
    cancel(reason) {
      abortController.abort();
      reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
