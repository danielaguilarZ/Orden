import { route, body } from "@/lib/http";
import { getStoredUsage } from "@/lib/claude/usage";
import { getAutopilotSettings, judgeBudget } from "@/lib/org/budget";
import { createUnit, listBacklog, listRoles, listUnits } from "@/lib/org/repo";
import { unitSchema } from "@/lib/org/schemas";
import type { UnitKind } from "@/lib/org/types";

export const dynamic = "force-dynamic";

/** Organigrama, carteras abiertas y estado del piloto automático. */
export const GET = route(() => {
  const settings = getAutopilotSettings();
  return {
    units: listUnits(),
    roles: listRoles(),
    backlog: listBacklog({ statuses: ["en_curso", "pendiente"], limit: 300 }),
    autopilot: { settings, verdict: judgeBudget(getStoredUsage(), settings) },
  };
});

export const POST = route(async (req) => {
  const input = unitSchema.parse(await body(req));
  return createUnit({ ...input, kind: input.kind as UnitKind });
});
