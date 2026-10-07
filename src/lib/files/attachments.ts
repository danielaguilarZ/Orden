import { todayIso } from "../agents/prompt";
import { ensureChildFolder, getNode, pathOf, readFileData, saveFile, type FileNode } from "./repo";
import { fileTypeOf, formatBytes } from "./rules";

/**
 * Adjuntos del chat: lo que el usuario suelta en una conversación o en una
 * decisión. Se guarda en «Adjuntos/AAAA-MM-DD», una carpeta COMPARTIDA, así
 * que cualquier agente puede leerlo después si necesita el contexto (por
 * ejemplo, al recibir una delegación). Las imágenes y los PDF, además, van
 * dentro del propio mensaje: el agente los ve sin tener que buscarlos.
 */

export const ATTACH_FOLDER = "Adjuntos";
/** Adjuntos por mensaje. */
export const MAX_ATTACHMENTS = 10;
/** Límites de la API de Claude para lo que va dentro del mensaje. */
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_INLINE_PDF = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const isImageType = (mime: string): mime is ImageType => (IMAGE_TYPES as readonly string[]).includes(mime);

export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
  mime: string;
  path: string;
}

export function toRef(node: FileNode): AttachmentRef {
  return { id: node.id, name: node.name, size: node.size, mime: node.mime, path: pathOf(node.id) };
}

/** Guarda un archivo soltado en el chat en «Adjuntos/<hoy>» (carpeta compartida). */
export function saveAttachment(name: string, data: Uint8Array, by: string | null = "user"): FileNode {
  const root = ensureChildFolder(null, ATTACH_FOLDER, by, { private: false });
  const day = ensureChildFolder(root.id, todayIso(), by, { private: false });
  return saveFile({ parentId: day.id, name, data, by });
}

/** Valida los ids que llegan de la web: archivos vivos, sin repetir y como mucho MAX_ATTACHMENTS. */
export function resolveAttachments(ids: unknown): AttachmentRef[] {
  if (!Array.isArray(ids)) return [];
  const unique = [...new Set(ids.map(String))];
  if (unique.length > MAX_ATTACHMENTS) throw new Error(`Como mucho ${MAX_ATTACHMENTS} adjuntos por mensaje.`);
  return unique.map((id) => {
    const node = getNode(id);
    if (!node || node.kind !== "archivo" || node.trashedAt) throw new Error("Uno de los adjuntos ya no existe.");
    return toRef(node);
  });
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageType; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

const baseMime = (mime: string) => mime.split(";")[0].trim();

/**
 * Bloques para el mensaje al modelo: una línea por adjunto (ruta y cómo
 * leerlo) y, para imágenes y PDF que quepan, el propio contenido.
 */
export function attachmentContent(refs: AttachmentRef[]): { note: string; blocks: ContentBlock[] } {
  const blocks: ContentBlock[] = [];
  const lines = refs.map((r) => {
    const mime = baseMime(r.mime);
    const kind = fileTypeOf(r.name)?.category ?? "archivo";
    const where = `«${r.path}» (${formatBytes(r.size)}, id ${r.id.slice(0, 8)})`;
    if (isImageType(mime) && r.size <= MAX_INLINE_IMAGE) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mime, data: readFileData(r.id).toString("base64") } });
      return `- Imagen ${where}: la tienes en este mensaje.`;
    }
    if (mime === "application/pdf" && r.size <= MAX_INLINE_PDF) {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: readFileData(r.id).toString("base64") }, title: r.name });
      return `- PDF ${where}: lo tienes en este mensaje.`;
    }
    return `- ${kind === "imagen" ? "Imagen" : kind.toUpperCase()} ${where}: léelo con archivo_leer.`;
  });
  const note = `<adjuntos>\nEl usuario ha adjuntado (quedan en Archivos, en la carpeta compartida «${ATTACH_FOLDER}»: cualquier compañero puede leerlos con archivo_leer si le delegas algo):\n${lines.join("\n")}\n</adjuntos>`;
  return { note, blocks };
}
