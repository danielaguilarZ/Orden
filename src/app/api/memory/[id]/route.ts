import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { archiveMemory, updateMemory } from "@/lib/repo/memory";

export const dynamic = "force-dynamic";

const schema = z.object({
  category: z.string().optional(),
  title: z.string().trim().min(1).optional(),
  content: z.string().trim().min(1).optional(),
  tags: z.array(z.string()).optional(),
  archived: z.boolean().optional(),
});

export const PATCH = route<IdCtx>(async (req, { params }) => updateMemory((await params).id, schema.parse(await body(req)), { by: "user" }));

/** Olvidar = archivar (recuperable). */
export const DELETE = route<IdCtx>(async (_req, { params }) => archiveMemory((await params).id, { by: "user" }));
