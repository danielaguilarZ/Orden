import { route, body, type IdCtx } from "@/lib/http";
import { getAgent } from "@/lib/repo/agents";
import { getRole, getUnit, listBacklog, setRole } from "@/lib/org/repo";
import { roleSchema } from "@/lib/org/schemas";

export const dynamic = "force-dynamic";

/** Puesto del agente y su cartera (abierta y lo último hecho). */
export const GET = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  if (!getAgent(id)) throw new Error("No existe ese agente.");
  return { role: getRole(id), backlog: listBacklog({ agentId: id, limit: 40 }) };
});

export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  if (!getAgent(id)) throw new Error("No existe ese agente.");
  const patch = roleSchema.parse(await body(req));
  if (patch.unitId && !getUnit(patch.unitId)) throw new Error("No existe esa unidad.");
  // Al cambiar de puesto puede volver a planificar en seguida.
  return setRole(id, { ...patch, planAfter: null });
});
