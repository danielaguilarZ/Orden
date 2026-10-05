import { route, type IdCtx } from "@/lib/http";
import { cancelTask } from "@/lib/repo/tasks";

export const dynamic = "force-dynamic";

/** Cancela un encargo (en cola: al momento, aunque el worker esté parado). */
export const POST = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  const task = cancelTask(id);
  if (!task) throw new Error("No existe ese encargo.");
  return task;
});
