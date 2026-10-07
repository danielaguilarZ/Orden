import path from "node:path";

/**
 * Reglas puras de la sección «Archivos»: nombres válidos, tipos admitidos,
 * comprobación del contenido real (firma), límite de tamaño y rutas
 * virtuales («Finanzas/Nóminas/nomina.pdf»). Sin BD ni disco: se testean solas.
 */

export type FileCategory = "pdf" | "csv" | "xlsx" | "imagen" | "texto";

export interface FileType {
  mime: string;
  category: FileCategory;
  /** Se puede ver en el navegador (iframe o img) sin descargar. */
  inline: boolean;
}

/** Tipos admitidos por extensión. SVG y HTML no: podrían ejecutar código al previsualizarlos. */
export const FILE_TYPES: Record<string, FileType> = {
  pdf: { mime: "application/pdf", category: "pdf", inline: true },
  csv: { mime: "text/csv; charset=utf-8", category: "csv", inline: false },
  tsv: { mime: "text/tab-separated-values; charset=utf-8", category: "csv", inline: false },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", category: "xlsx", inline: false },
  png: { mime: "image/png", category: "imagen", inline: true },
  jpg: { mime: "image/jpeg", category: "imagen", inline: true },
  jpeg: { mime: "image/jpeg", category: "imagen", inline: true },
  gif: { mime: "image/gif", category: "imagen", inline: true },
  webp: { mime: "image/webp", category: "imagen", inline: true },
  txt: { mime: "text/plain; charset=utf-8", category: "texto", inline: false },
  md: { mime: "text/markdown; charset=utf-8", category: "texto", inline: false },
  // Más texto que suele llegar al chat (el XML se sirve como texto plano). HTML y SVG no, a propósito.
  json: { mime: "application/json; charset=utf-8", category: "texto", inline: false },
  xml: { mime: "text/plain; charset=utf-8", category: "texto", inline: false },
  yml: { mime: "text/plain; charset=utf-8", category: "texto", inline: false },
  yaml: { mime: "text/plain; charset=utf-8", category: "texto", inline: false },
  log: { mime: "text/plain; charset=utf-8", category: "texto", inline: false },
};

export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

/** Tamaño máximo por archivo (ORDEN_FILES_MAX_MB, 25 MB por defecto). */
export function maxFileBytes(): number {
  const mb = Number(process.env.ORDEN_FILES_MAX_MB ?? 25);
  return Math.round((Number.isFinite(mb) && mb > 0 ? mb : 25) * 1024 * 1024);
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function fileTypeOf(name: string): FileType | null {
  return FILE_TYPES[extensionOf(name)] ?? null;
}

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export const MAX_NAME = 120;

/** Normaliza y valida el nombre de una carpeta o archivo. Lanza un error legible si no vale. */
export function cleanName(raw: string): string {
  const name = String(raw ?? "").normalize("NFC").trim();
  if (!name) throw new Error("El nombre no puede estar vacío.");
  if (name.length > MAX_NAME) throw new Error(`El nombre es demasiado largo (máximo ${MAX_NAME} caracteres).`);
  if (name === "." || name === "..") throw new Error("Ese nombre no está permitido.");
  if (FORBIDDEN.test(name)) throw new Error('El nombre no puede llevar \\ / : * ? " < > | ni caracteres de control.');
  if (/[. ]$/.test(name)) throw new Error("El nombre no puede acabar en punto ni en espacio.");
  if (RESERVED.test(name)) throw new Error("Ese nombre está reservado por Windows.");
  return name;
}

/** Clave para comparar nombres sin distinguir mayúsculas ni tildes («Nóminas» = «nominas»). */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

/** «nomina.pdf» → «nomina (2).pdf» si ya existe (lo mismo con carpetas, sin extensión). */
export function uniqueName(name: string, taken: (key: string) => boolean): string {
  if (!taken(nameKey(name))) return name;
  const ext = extensionOf(name);
  const base = ext ? name.slice(0, -(ext.length + 1)) : name;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} (${i})${ext ? `.${ext}` : ""}`;
    if (!taken(nameKey(candidate))) return candidate;
  }
  throw new Error("Demasiados archivos con ese nombre.");
}

function startsWith(data: Uint8Array, bytes: number[], at = 0): boolean {
  return bytes.every((b, i) => data[at + i] === b);
}

/**
 * Comprueba que el contenido coincide con la extensión (no basta con renombrar
 * un .exe a .pdf). Devuelve el tipo o lanza un error.
 */
export function checkContent(name: string, data: Uint8Array): FileType {
  const type = fileTypeOf(name);
  if (!type) throw new Error(`Tipo no admitido. Se aceptan: ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(", ")}.`);
  if (data.length === 0) throw new Error("El archivo está vacío.");
  if (data.length > maxFileBytes()) throw new Error(`El archivo supera el límite de ${formatBytes(maxFileBytes())}.`);
  const ext = extensionOf(name);
  const head = Buffer.from(data.subarray(0, 1024)).toString("latin1");
  const ok =
    type.category === "pdf"
      ? head.includes("%PDF-")
      : type.category === "xlsx"
        ? startsWith(data, [0x50, 0x4b, 0x03, 0x04])
        : ext === "png"
          ? startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          : ext === "jpg" || ext === "jpeg"
            ? startsWith(data, [0xff, 0xd8, 0xff])
            : ext === "gif"
              ? head.startsWith("GIF87a") || head.startsWith("GIF89a")
              : ext === "webp"
                ? head.startsWith("RIFF") && head.slice(8, 12) === "WEBP"
                : !data.subarray(0, 8192).includes(0); // texto: sin bytes nulos
  if (!ok) throw new Error(`El contenido no parece un .${ext} válido.`);
  return type;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} KB`;
  return `${(n / 1024 / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB`;
}

/**
 * Trocea una ruta virtual escrita por un agente o por la interfaz.
 * Admite / y \, ignora segmentos vacíos y rechaza «.» y «..»: nunca se puede
 * salir de la raíz de Archivos.
 */
export function splitVirtualPath(raw: string): string[] {
  const parts = String(raw ?? "")
    .split(/[/\\]+/)
    .map((p) => p.normalize("NFC").trim())
    .filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) throw new Error("Ruta no válida: no se permiten «.» ni «..».");
  return parts;
}

/** ¿`target` está dentro de `root` (sin ser la propia raíz)? Protección extra al tocar el disco. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(id: string): boolean {
  return UUID.test(id);
}

/** Cabecera Content-Disposition con nombre UTF-8 (y uno ASCII de respaldo). */
export function contentDisposition(name: string, download: boolean): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
