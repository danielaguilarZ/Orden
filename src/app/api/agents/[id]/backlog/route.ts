import { route, body, type IdCtx } from "@/lib/http";
import { getAgent } from "@/lib/repo/agents";
import { addItem, getRole } from "@/lib/org/repo";
import { itemSchema } from "@/lib/org/schemas";

export const dynamic = "force-dynamic";

/** El usuario añade trabajo a la cartera de un agente. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  if (!getAgent(id)) throw new Error("No existe ese agente.");
  const input = itemSchema.parse(await body(req));
  return addItem({ ...input, agentId: id, unitId: input.unitId ?? getRole(id).unitId, source: "usuario" });
});
