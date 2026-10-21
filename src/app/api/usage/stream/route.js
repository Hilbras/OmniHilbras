import { getActiveRequests, getPendingRequests, statsEmitter } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// The live view of the usage page.
//
// It pushes only what changes live: the requests in flight, the last requests
// and the in-flight counters. The numbers that need the database come from
// /api/usage/stats, which the client asks for when the period changes.
//
// It used to recompute the whole statistics on every update event — up to four
// times a second per connected dashboard — with the default period ("all"),
// which parses every retained day. The client ignored those numbers: it merges
// only the live fields from this stream. So the cost bought nothing.
export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null };

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        if (state.closed) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
          const payload = {
            activeRequests,
            recentRequests,
            errorProvider,
            pending: getPendingRequests(),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.send);
          clearInterval(state.keepalive);
        }
      };

      state.send = push;

      await push();

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.send);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
