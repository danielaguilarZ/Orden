import { route } from "@/lib/http";
import { saveAttachment, toRef } from "@/lib/files/attachments";
import { logActivity } from "@/lib/repo/system";
import { formatBytes, maxFileBytes } from "@/lib/files/rules";
import { readBodyLimited } from "@/lib/files/upload";

export const dynamic = "force-dynamic";

/**
 * Sube un adjunto del chat (cuerpo en bruto, nombre en ?name=). Va a la carpeta
 * compartida «Adjuntos/<hoy>» de Archivos y devuelve su referencia para el mensaje.
 */
export const POST = route(async (req) => {
  const name = new URL(req.url).searchParams.get("name") ?? "";
  const max = maxFileBytes();
  if (Number(req.headers.get("content-length") ?? 0) > max) return Response.json({ error: `«${name}» supera el límite de ${formatBytes(max)}.` }, { status: 413 });
  const node = saveAttachment(name, await readBodyLimited(req, max));
  const ref = toRef(node);
  logActivity("archivos", `Adjunto «${ref.path}» (${formatBytes(node.size)})`, null, { fileId: node.id });
  return ref;
});
