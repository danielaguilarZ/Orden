import { route, body, type IdCtx } from "@/lib/http";
import { answerDecision, DECISION_ACTIONS, postponeDecision, reopenDecision, type DecisionAction } from "@/lib/decisions/repo";

export const dynamic = "force-dynamic";

/**
 * Respuesta del usuario: responder (texto y/u opción), aceptar o rechazar
 * (comentario opcional), aplazar (días) o reabrir una resuelta. La respuesta
 * llega al agente al momento (el worker lo coge en su siguiente vuelta).
 */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const b = await body<{ accion?: string; respuesta?: string; opcion?: string; dias?: number }>(req);
  const action = b.accion as DecisionAction;
  if (!DECISION_ACTIONS.includes(action)) throw new Error("Acción desconocida.");
  if (action === "aplazar") return postponeDecision(id, Number(b.dias ?? 7));
  if (action === "reabrir") return reopenDecision(id);
  return answerDecision(id, { action, text: b.respuesta, option: b.opcion });
});
