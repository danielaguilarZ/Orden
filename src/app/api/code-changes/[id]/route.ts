import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { applyChange, discardChange, getChange } from "@/lib/dev/workspace";

export const dynamic = "force-dynamic";

export const GET = route<IdCtx>(async (_req, { params }) => {
  const c = getChange((await params).id);
  if (!c) throw new Error("No existe esa propuesta.");
  return c;
});

/** { action: "apply" } valida, fusiona y reinicia · { action: "discard" } la descarta. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const { action } = z.object({ action: z.enum(["apply", "discard"]) }).parse(await body(req));
  return action === "apply" ? applyChange(id) : discardChange(id);
});
