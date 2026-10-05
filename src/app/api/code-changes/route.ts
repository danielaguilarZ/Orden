import { route } from "@/lib/http";
import { listChanges } from "@/lib/dev/workspace";

export const dynamic = "force-dynamic";

/** Propuestas de cambios de código (?agentId= para las de un agente). */
export const GET = route((req) => listChanges(new URL(req.url).searchParams.get("agentId") ?? undefined));
