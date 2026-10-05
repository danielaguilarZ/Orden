import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { deleteRoutine, updateRoutine } from "@/lib/repo/routines";
import { scheduleSchema } from "@/lib/routines/schedule";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
  schedule: scheduleSchema.optional(),
  enabled: z.boolean().optional(),
});

export const PATCH = route<IdCtx>(async (req, { params }) => updateRoutine((await params).id, schema.parse(await body(req))));

export const DELETE = route<IdCtx>(async (_req, { params }) => {
  deleteRoutine((await params).id);
  return { ok: true };
});
