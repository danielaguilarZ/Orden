import { route } from "@/lib/http";
import { authorOf, countPending, listDecisions } from "@/lib/decisions/repo";

export const dynamic = "force-dynamic";

/** Todas las decisiones (con el nombre del autor) y cuántas quedan por responder. */
export const GET = route(() => ({
  decisions: listDecisions().map((d) => ({ ...d, authorName: authorOf(d) })),
  pending: countPending(),
}));
