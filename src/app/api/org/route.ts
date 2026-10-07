import { route, body } from "@/lib/http";
import { getHeartbeat } from "@/lib/repo/system";
import { getStoredUsage } from "@/lib/claude/usage";
import { getAutopilotSettings, judgeBudget } from "@/lib/org/budget";
import { createUnit, listBacklog, listRoles, listUnits } from "@/lib/org/repo";
import { unitSchema } from "@/lib/org/schemas";
import type { UnitKind } from "@/lib/org/types";

export const dynamic = "force-dynamic";

/** Encargos a la vez que admite el worker (lo publica en su latido; 3 si aún no lo dice). */
function workerMax(): number {
  const max = Number(getHeartbeat("worker")?.info.max);
  return Number.isFinite(max) && max > 0 ? max : 3;
}

/** Organigrama, carteras abiertas y estado del piloto automático. */
export const GET = route(() => {
  const settings = getAutopilotSettings();
  return {
    units: listUnits(),
    roles: listRoles(),
    backlog: listBacklog({ statuses: ["en_curso", "pendiente"], limit: 300 }),
    autopilot: { settings, verdict: judgeBudget(getStoredUsage(), settings), workerMax: workerMax() },
  };
});

export const POST = route(async (req) => {
  const input = unitSchema.parse(await body(req));
  return createUnit({ ...input, kind: input.kind as UnitKind });
});
