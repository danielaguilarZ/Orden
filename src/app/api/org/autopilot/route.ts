import { route, body } from "@/lib/http";
import { getStoredUsage } from "@/lib/claude/usage";
import { judgeBudget, setAutopilotSettings } from "@/lib/org/budget";
import { logActivity } from "@/lib/repo/system";
import { autopilotSchema } from "@/lib/org/schemas";

export const dynamic = "force-dynamic";

/** Encender, apagar o ajustar los topes del piloto automático. */
export const PATCH = route(async (req) => {
  const patch = autopilotSchema.parse(await body(req));
  const settings = setAutopilotSettings(patch);
  if (patch.enabled !== undefined) logActivity("autonomo", `Piloto automático ${patch.enabled ? "encendido" : "apagado"}`);
  return { settings, verdict: judgeBudget(getStoredUsage(), settings) };
});
