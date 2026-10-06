import { NextResponse } from "next/server";
import { route, type IdCtx } from "@/lib/http";
import "@/lib/connections";
import { receiveWebhook, tokenFrom, WebhookError, MAX_BODY } from "@/lib/connections/webhook-in";

export const dynamic = "force-dynamic";

/**
 * Webhook entrante: POST con «Authorization: Bearer <clave>» (o
 * «X-Orden-Token») y un JSON o texto. Solo desde este PC, como toda la API.
 */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return NextResponse.json({ error: `Cuerpo demasiado grande (máx. ${MAX_BODY / 1000} KB).` }, { status: 413 });
  try {
    return receiveWebhook(id, tokenFrom(req.headers), await req.text());
  } catch (err) {
    if (err instanceof WebhookError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
