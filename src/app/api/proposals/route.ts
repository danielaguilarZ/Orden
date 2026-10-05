import { route } from "@/lib/http";
import { countPending, listProposals, authorOf } from "@/lib/proposals/repo";

export const dynamic = "force-dynamic";

/** Todas las propuestas (con el nombre del autor) y cuántas quedan por decidir. */
export const GET = route(() => ({
  proposals: listProposals().map((p) => ({ ...p, authorName: authorOf(p) })),
  pending: countPending(),
}));
