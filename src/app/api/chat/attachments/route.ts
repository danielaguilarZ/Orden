import { route } from "@/lib/http";
import { saveAttachment } from "@/lib/chat/attachments";
import { formatBytes, maxFileBytes } from "@/lib/files/rules";
import { readBodyLimited } from "@/lib/files/upload";

export const dynamic = "force-dynamic";

/**
 * Subida de UN adjunto del chat (arrastrado o pegado): cuerpo en bruto y el
 * nombre en la URL (?name=). Se guarda en Archivos/Adjuntos y devuelve su ficha.
 */
export const POST = route(async (req) => {
  const name = new URL(req.url).searchParams.get("name") ?? "";
  const max = maxFileBytes();
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return Response.json({ error: `«${name}» supera el límite de ${formatBytes(max)}.` }, { status: 413 });
  return saveAttachment(name, await readBodyLimited(req, max));
});
