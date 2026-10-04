import { z } from "zod";
import { route, body } from "@/lib/http";
import { reorderPanels } from "@/lib/repo/panels";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const { ids } = z.object({ ids: z.array(z.string()) }).parse(await body(req));
  reorderPanels(ids);
  return { ok: true };
});
