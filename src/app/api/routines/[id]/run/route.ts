import { route, type IdCtx } from "@/lib/http";
import { getRoutine } from "@/lib/repo/routines";
import { fireRoutine } from "@/lib/routines/runner";

export const dynamic = "force-dynamic";

/** «Ejecutar ahora»: encola la rutina sin cambiar su próxima hora. */
export const POST = route<IdCtx>(async (_req, { params }) => {
  const r = getRoutine((await params).id);
  if (!r) throw new Error("No existe esa rutina.");
  const task = fireRoutine(r, new Date(), true);
  if (!task) throw new Error("La ejecución anterior sigue en marcha.");
  return task;
});
