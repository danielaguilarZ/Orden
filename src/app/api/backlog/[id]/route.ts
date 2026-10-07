import { route, body, type IdCtx } from "@/lib/http";
import { deleteItem, getItem, updateItem } from "@/lib/org/repo";
import { itemPatchSchema } from "@/lib/org/schemas";

export const dynamic = "force-dynamic";

export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const item = getItem(id);
  if (!item) throw new Error("No existe esa tarea.");
  if (item.status === "en_curso") throw new Error("Está en marcha: espera a que termine.");
  return updateItem(id, itemPatchSchema.parse(await body(req)));
});

export const DELETE = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  if (getItem(id)?.status === "en_curso") throw new Error("Está en marcha: espera a que termine.");
  deleteItem(id);
  return { ok: true };
});
