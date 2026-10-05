import { forbidden, isLocalRequest } from "@/lib/localhost";
import { eventsAfter, lastEventId } from "@/lib/events";
import { boot, systemStatus } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Tiempo real por SSE. La web y el worker escriben eventos en SQLite; aquí se
 * sondea la tabla cada 300 ms y se reenvían. Cada 5 s se manda el estado del
 * sistema (latido del worker).
 */
export async function GET(req: Request) {
  if (!isLocalRequest(req)) return forbidden();
  boot();
  const url = new URL(req.url);
  const header = req.headers.get("last-event-id");
  let last = Number(header ?? url.searchParams.get("after") ?? NaN);
  if (!Number.isFinite(last)) last = lastEventId();

  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          if (timer) clearInterval(timer);
        }
      };
      send("retry: 2000\n\n");
      send(`event: system\ndata: ${JSON.stringify(systemStatus())}\n\n`);
      let systemAt = Date.now();
      timer = setInterval(() => {
        try {
          for (const e of eventsAfter(last)) {
            send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
            last = e.id;
          }
          if (Date.now() - systemAt > 5000) {
            systemAt = Date.now();
            send(`event: system\ndata: ${JSON.stringify(systemStatus())}\n\n`);
          }
        } catch (err) {
          send(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
        }
      }, 300);
      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
