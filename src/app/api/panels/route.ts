import { z } from "zod";
import { route, body } from "@/lib/http";
import { createPanel, listPanels } from "@/lib/repo/panels";

export const dynamic = "force-dynamic";

export const GET = route((req) => listPanels({ archived: new URL(req.url).searchParams.get("archived") === "1" }));

const createSchema = z.object({ type: z.string(), title: z.string().default(""), data: z.unknown().optional() });

export const POST = route(async (req) => {
  const input = createSchema.parse(await body(req));
  return createPanel({ ...input, actor: { by: "user" } });
});
