import { route, body, type IdCtx } from "@/lib/http";
import { getNode, moveNode, purgeNode, renameNode, restoreNode, setFolderPrivate, trashNode } from "@/lib/files/repo";

export const dynamic = "force-dynamic";

interface Patch {
  name?: string;
  /** null = a la raíz. */
  parentId?: string | null;
  private?: boolean;
}

/** Renombrar, mover o cambiar la privacidad de una carpeta. */
export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const b = await body<Patch>(req);
  if (b.name !== undefined) renameNode(id, b.name);
  if (b.parentId !== undefined) moveNode(id, b.parentId);
  if (b.private !== undefined) setFolderPrivate(id, Boolean(b.private));
  const node = getNode(id);
  if (!node) throw new Error("No existe.");
  return node;
});

/** A la papelera; con ?forever=1, borrar para siempre (solo desde la papelera). */
export const DELETE = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  if (new URL(req.url).searchParams.get("forever")) {
    purgeNode(id);
    return { ok: true };
  }
  return trashNode(id);
});

/** Recuperar de la papelera. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const { action } = await body<{ action?: string }>(req);
  if (action === "recuperar") return restoreNode(id);
  throw new Error("Acción desconocida.");
});
