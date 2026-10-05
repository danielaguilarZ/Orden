import { route, type IdCtx } from "@/lib/http";
import { FileTree, readFileData } from "@/lib/files/repo";
import { contentDisposition, fileTypeOf } from "@/lib/files/rules";

export const dynamic = "force-dynamic";

/**
 * Contenido de un archivo. Por defecto se ve en el navegador si es PDF o
 * imagen; con ?download=1 (o si es de otro tipo) se descarga.
 */
export const GET = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const t = new FileTree();
  const node = t.byId.get(id);
  if (!node || node.kind !== "archivo" || !t.isLive(node)) return Response.json({ error: "Ese archivo no existe." }, { status: 404 });
  const type = fileTypeOf(node.name);
  const download = Boolean(new URL(req.url).searchParams.get("download")) || !type?.inline;
  const data = readFileData(id);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": type?.mime ?? "application/octet-stream",
      "Content-Length": String(data.length),
      "Content-Disposition": contentDisposition(node.name, download),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
