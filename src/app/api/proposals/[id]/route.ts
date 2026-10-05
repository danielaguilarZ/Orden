import { route, body, type IdCtx } from "@/lib/http";
import { decideProposal, dispatchAccepted, type Decision } from "@/lib/proposals/repo";

export const dynamic = "force-dynamic";

const DECISIONS: Decision[] = ["aceptar", "rechazar", "aplazar", "reabrir"];

/** Decisión del usuario: aceptar, rechazar (motivo opcional), aplazar (días) o recuperar una rechazada. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const b = await body<{ accion?: string; motivo?: string; dias?: number }>(req);
  if (!DECISIONS.includes(b.accion as Decision)) throw new Error("Acción desconocida.");
  const p = decideProposal(id, b.accion as Decision, { reason: b.motivo, days: b.dias });
  // Al aceptar, Zen recibe el encargo al momento (el worker lo coge en su siguiente vuelta).
  if (p.status === "aceptada") dispatchAccepted();
  return p;
});
