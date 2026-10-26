import { NextResponse } from "next/server";
import { pingModelByKind } from "../test/ping";
import { mapWithConcurrency } from "@/lib/async/mapWithConcurrency.js";
import { setCachedTestResults } from "../testCache.js";
import { modelIdFromTestModel } from "@/shared/utils/modelIdFromTestModel.js";

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
  const results = [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      // Bounded: a provider with a hundred models gets four pings at a time,
      // not a hundred sockets.
      await mapWithConcurrency(
        models,
        async (model) => {
          let result;
          try {
            result = await pingModelByKind(model, kind);
          } catch (err) {
            result = { ok: false, error: err?.message || "Test failed" };
          }
          send({ model, ...result });
          results.push(result);
          return result;
        },
        CONCURRENCY,
      );

      const passed = results.filter((r) => r?.ok).length;
      send({ done: true, summary: { total: models.length, passed, failed: models.length - passed } });
      // Cache the results keyed by the first model's provider alias so the
      // dashboard can surface "last tested" without a live run.
      if (models.length > 0) {
        const firstAlias = models[0].split("/")[0];
        const resultMap = {};
        results.forEach((r, i) => {
          const mid = modelIdFromTestModel(models[i], firstAlias);
          if (mid) resultMap[mid] = r.ok ? "ok" : "error";
        });
        try { setCachedTestResults(firstAlias, resultMap); } catch { /* non-fatal */ }
      }
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
