import { NextResponse } from "next/server";
import { pingModelByKind } from "../test/ping";

// POST /api/models/test-batch - Test many models of one provider
//
// Body: { models: ["<alias>/<modelId>", ...], kind?: "llm" }
//
// A provider can expose a hundred models, and testing them one at a time from
// the browser is slow enough that people stop doing it.
//
// The answer is a newline-delimited JSON stream: one line per model as it
// finishes, then a final line carrying the summary. The page paints each
// model as it lands, so a run over a hundred models shows its progress
// instead of a spinner that says nothing for minutes.
//
// The per-model result is exactly what the single-model test returns, so a
// model tested here and a model tested by hand are judged the same way.

const CONCURRENCY = 4;
const MAX_MODELS = 200;

export async function POST(request) {
  let models = [];
  let kind = "llm";
  try {
    const body = await request.json().catch(() => ({}));
    models = Array.isArray(body?.models) ? body.models : [];
    if (typeof body?.kind === "string" && body.kind) kind = body.kind;
  } catch {
    /* handled below */
  }

  if (models.length === 0) {
    return NextResponse.json({ error: "models[] is required" }, { status: 400 });
  }
  if (models.length > MAX_MODELS) {
    return NextResponse.json(
      { error: `Too many models (${models.length}); the limit is ${MAX_MODELS}` },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  let cursor = 0;
  let passed = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      const worker = async () => {
        while (cursor < models.length) {
          const index = cursor;
          cursor += 1;
          const model = models[index];
          let result;
          try {
            result = await pingModelByKind(model, kind);
          } catch (err) {
            result = { ok: false, error: err?.message || "Test failed" };
          }
          if (result?.ok) passed += 1;
          send({ model, ...result });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, models.length) }, () => worker()),
      );

      send({ done: true, summary: { total: models.length, passed, failed: models.length - passed } });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
