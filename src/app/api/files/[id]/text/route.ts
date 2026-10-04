import { route, type IdCtx } from "@/lib/http";
import { FileTree, readFileData } from "@/lib/files/repo";
import { contentVersion, extractCached } from "@/lib/files/read";

export const dynamic = "force-dynamic";

const MAX = 200_000;

/** Texto extraído (lo mismo que leen los agentes), para revisarlo desde la interfaz. */
export const GET = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  const t = new FileTree();
  const node = t.byId.get(id);
  if (!node || node.kind !== "archivo" || !t.isLive(node)) throw new Error("Ese archivo no existe.");
  const ex = extractCached(node.id, node.name, () => readFileData(node.id), contentVersion(node));
  return { ...ex, text: ex.text.slice(0, MAX), truncated: ex.text.length > MAX };
});
