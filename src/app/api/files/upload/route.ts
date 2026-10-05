import { route } from "@/lib/http";
import { pathOf, saveFile } from "@/lib/files/repo";
import { logActivity } from "@/lib/repo/system";
import { formatBytes, maxFileBytes } from "@/lib/files/rules";
import { readBodyLimited } from "@/lib/files/upload";

export const dynamic = "force-dynamic";

/**
 * Subida de UN archivo: el cuerpo es el contenido en bruto (sin multipart) y
 * la carpeta y el nombre van en la URL: ?folder=<id>&name=<nombre>.
 * Se corta en cuanto supera el límite, sin leer el resto.
 */
export const POST = route(async (req) => {
  const url = new URL(req.url);
  const folder = url.searchParams.get("folder") || null;
  const name = url.searchParams.get("name") ?? "";
  const max = maxFileBytes();
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return Response.json({ error: `«${name}» supera el límite de ${formatBytes(max)}.` }, { status: 413 });
  const data = await readBodyLimited(req, max);
  const node = saveFile({ parentId: folder, name, data, by: "user" });
  logActivity("archivos", `Subido «${pathOf(node.id)}» (${formatBytes(node.size)})`, null, { fileId: node.id });
  return node;
});
