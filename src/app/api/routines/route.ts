import { z } from "zod";
import { route, body } from "@/lib/http";
import { createRoutine, listRoutines } from "@/lib/repo/routines";
import { scheduleSchema } from "@/lib/routines/schedule";

export const dynamic = "force-dynamic";

export const GET = route((req) => listRoutines(new URL(req.url).searchParams.get("agentId") ?? undefined));

const schema = z.object({
  agentId: z.string(),
  name: z.string().trim().min(1, "Ponle nombre"),
  prompt: z.string().trim().min(1, "Explica qué debe hacer"),
  schedule: scheduleSchema,
  enabled: z.boolean().optional(),
});

export const POST = route(async (req) => createRoutine(schema.parse(await body(req))));
