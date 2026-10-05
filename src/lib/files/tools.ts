import { z } from "zod";
import { defineTool, fail, ok, registerTools, type ToolDef } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import { logActivity } from "../repo/system";
import type { Agent } from "../types";
import {
  DAILY_FOLDER,
  fileAccessOf,
  FileTree,
  hasSharedFolders,
  readFileData,
  resolveForAgent,
  visibleTo,
  writeDailyFile,
  type FileAccess,
  type FileNode,
} from "./repo";
import { contentVersion, extractCached } from "./read";
import { formatBytes, nameKey } from "./rules";

/**
 * Herramientas de Archivos para los agentes: lectura (listar, buscar y leer).
 * Quien tiene acceso a todo (el jefe y a quien se le dé) ve también las
 * carpetas privadas; el resto, solo las compartidas. Escritura: solo el jefe y
 * solo archivos de texto dentro de «Daily» (archivo_escribir), sin borrar ni mover.
 */

const MAX_LIST = 400;
const DEFAULT_CHARS = 30_000;

function lineOf(t: FileTree, n: FileNode, indent = ""): string {
  if (n.kind === "carpeta") {
    const count = t.children(n.id).length;
    return `${indent}- 📁 ${n.name}/ (${count} elemento${count === 1 ? "" : "s"}${n.private ? ", privada" : ""})`;
  }
  return `${indent}- ${n.name} · ${formatBytes(n.size)} · ${n.createdAt.slice(0, 10)} · id ${n.id.slice(0, 8)}`;
}

/** Lista una carpeta (o el árbol entero con recursivo). Expuesta para tests. */
export function listForAgent(access: FileAccess, carpeta?: string, recursivo = false): string {
  const t = new FileTree();
  let folder: FileNode | null = null;
  if (carpeta?.trim()) {
    folder = resolveForAgent(t, access, carpeta);
    if (!folder) throw new Error(`No encuentro la carpeta «${carpeta}» (o no tienes acceso).`);
    if (folder.kind !== "carpeta") throw new Error(`«${carpeta}» es un archivo: léelo con archivo_leer.`);
  }
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const kids = t
      .children(parentId)
      .filter((n) => visibleTo(t, access, n))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "es") : a.kind === "carpeta" ? -1 : 1));
    for (const n of kids) {
      if (lines.length >= MAX_LIST) return;
      lines.push(lineOf(t, n, "  ".repeat(depth)));
      if (recursivo && n.kind === "carpeta") walk(n.id, depth + 1);
    }
  };
  walk(folder?.id ?? null, 0);
  const where = folder ? `«${t.pathOf(folder)}»${folder.private ? " (privada)" : ""}` : "raíz de Archivos";
  if (!lines.length) return `${where}: vacía${access === "compartido" && !folder ? " (solo ves las carpetas compartidas)" : ""}.`;
  return `${where}:\n${lines.join("\n")}${lines.length >= MAX_LIST ? `\n… (lista cortada en ${MAX_LIST})` : ""}`;
}

/** Busca archivos y carpetas por nombre (sin tildes ni mayúsculas). */
export function searchForAgent(access: FileAccess, texto: string): string {
  const t = new FileTree();
  const words = nameKey(texto).split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("Escribe qué buscar.");
  const hits = t
    .live()
    .filter((n) => visibleTo(t, access, n))
    .filter((n) => {
      const key = nameKey(t.pathOf(n));
      return words.every((w) => key.includes(w));
    })
    .slice(0, 50);
  if (!hits.length) return `Nada coincide con «${texto}».`;
  return hits.map((n) => (n.kind === "carpeta" ? `- 📁 ${t.pathOf(n)}/` : `- ${t.pathOf(n)} · ${formatBytes(n.size)} · ${n.createdAt.slice(0, 10)} · id ${n.id.slice(0, 8)}`)).join("\n");
}

/** Lee un archivo (texto extraído), por trozos. Expuesta para tests. */
export function readForAgent(access: FileAccess, ref: string, desde = 0, max = DEFAULT_CHARS): { text: string; node: FileNode; path: string } {
  const t = new FileTree();
  const node = resolveForAgent(t, access, ref);
  if (!node) throw new Error(`No encuentro «${ref}» (o no tienes acceso). Mira la lista con archivos_listar.`);
  if (node.kind === "carpeta") throw new Error(`«${ref}» es una carpeta: usa archivos_listar.`);
  const ex = extractCached(node.id, node.name, () => readFileData(node.id), contentVersion(node));
  const path = t.pathOf(node);
  const start = Math.max(0, Math.min(desde, ex.text.length));
  const chunk = ex.text.slice(start, start + max);
  const rest = ex.text.length - (start + chunk.length);
  const head = [`«${path}» · ${ex.label}${ex.detail ? ` · ${ex.detail}` : ""} · ${formatBytes(node.size)} · ${ex.text.length.toLocaleString("es-ES")} caracteres`];
  if (start) head.push(`(desde el carácter ${start.toLocaleString("es-ES")})`);
  if (ex.warning) head.push(`Aviso: ${ex.warning}`);
  const tail = rest > 0 ? `\n\n… quedan ${rest.toLocaleString("es-ES")} caracteres: vuelve a llamar con desde=${start + chunk.length}.` : "";
  return { text: `${head.join("\n")}\n\n${chunk}${tail}`, node, path };
}

function fileTools(ctx: { agent: Agent; note: (text: string, data?: Record<string, unknown>) => void }): ToolDef[] {
  const { agent } = ctx;
  const access = fileAccessOf(agent);
  return [
    defineTool(
      "archivos_listar",
      "Lista las carpetas y archivos de la sección Archivos (lo que ha subido el usuario: nóminas, extractos, documentos…). Sin carpeta, la raíz. Con recursivo:true, el árbol entero.",
      {
        carpeta: z.string().optional().describe("Ruta, p. ej. «Finanzas/Extractos bancarios», o id"),
        recursivo: z.boolean().optional(),
      },
      async ({ carpeta, recursivo }) => {
        try {
          return ok(listForAgent(access, carpeta, recursivo ?? false));
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
    defineTool(
      "archivos_buscar",
      "Busca archivos y carpetas por nombre o ruta (sin distinguir tildes ni mayúsculas), p. ej. «nomina septiembre».",
      { texto: z.string().min(1) },
      async ({ texto }) => {
        try {
          return ok(searchForAgent(access, texto));
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
    defineTool(
      "archivo_leer",
      "Lee el contenido de un archivo: texto de un PDF (por páginas), filas de un CSV o de las hojas de un XLSX (columnas separadas por « | ») o texto plano. Los textos largos van por trozos: usa «desde» para seguir.",
      {
        archivo: z.string().describe("Ruta (p. ej. «Finanzas/Nóminas/nomina-2026-09.pdf») o id"),
        desde: z.number().int().min(0).optional().describe("Carácter desde el que seguir leyendo"),
        max: z.number().int().min(1000).max(60_000).optional().describe(`Caracteres como mucho (por defecto ${DEFAULT_CHARS})`),
      },
      async ({ archivo, desde, max }) => {
        try {
          const r = readForAgent(access, archivo, desde ?? 0, max ?? DEFAULT_CHARS);
          if (!desde) {
            ctx.note(`Ha leído «${r.path}»`, { kind: "file", fileId: r.node.id });
            logActivity("archivos", `${agent.name} ha leído «${r.path}»`, agent.id, { fileId: r.node.id });
          }
          return ok(r.text);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
  ];
}

const MAX_WRITE = 200_000;

/** Escritura en «Daily»: solo para el jefe. */
function writeTools(ctx: { agent: Agent; note: (text: string, data?: Record<string, unknown>) => void }): ToolDef[] {
  const { agent } = ctx;
  return [
    defineTool(
      "archivo_escribir",
      `Crea o actualiza un archivo de texto (.md o .txt) dentro de la carpeta «${DAILY_FOLDER}» de Archivos (o sus subcarpetas); crea las carpetas que falten. Si ya existe, lo sustituye (o añade al final con anadir:true). Fuera de «${DAILY_FOLDER}» no se puede escribir, ni borrar ni mover nada.`,
      {
        ruta: z.string().min(1).describe(`Ruta del archivo, p. ej. «${DAILY_FOLDER}/resumen 2026-10-04» (sin extensión se guarda como .md)`),
        contenido: z.string().min(1).max(MAX_WRITE).describe("Texto o markdown"),
        anadir: z.boolean().optional().describe("true = añadir al final en vez de sustituir"),
      },
      async ({ ruta, contenido, anadir }) => {
        try {
          const r = writeDailyFile({ path: ruta, content: contenido, append: anadir ?? false, by: agent.id });
          const verb = r.created ? "creado" : anadir ? "añadido texto a" : "actualizado";
          ctx.note(`Ha ${verb} «${r.path}»`, { kind: "file", fileId: r.node.id });
          logActivity("archivos", `${agent.name} ha ${verb} «${r.path}»`, agent.id, { fileId: r.node.id });
          return ok(`Hecho: ${verb} «${r.path}» (${formatBytes(r.node.size)}, id ${r.node.id.slice(0, 8)}).`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
  ];
}

registerTools((ctx) => {
  if (ctx.task.kind === "ambient") return [];
  if (ctx.agent.isChief) return [...fileTools(ctx), ...writeTools(ctx)];
  // Sin acceso a todo y sin carpetas compartidas no hay nada que ver: no se gastan tokens en herramientas.
  if (fileAccessOf(ctx.agent) !== "todo" && !hasSharedFolders()) return [];
  return fileTools(ctx);
});

registerPromptSection((agent) => {
  const access = fileAccessOf(agent);
  if (access !== "todo" && !hasSharedFolders()) return null;
  return `Archivos (sección de Paneles): el usuario sube documentos (PDF, CSV, XLSX, imágenes, texto) organizados en carpetas.
- Tu acceso: ${access === "todo" ? "todo, incluidas las carpetas privadas (finanzas y personales)" : "solo las carpetas compartidas; las privadas no las ves"}. ${
    agent.isChief
      ? `Solo lectura, salvo la carpeta «${DAILY_FOLDER}»: ahí puedes crear o actualizar archivos de texto/markdown con archivo_escribir (p. ej. «${DAILY_FOLDER}/resumen AAAA-MM-DD»). Nunca puedes borrar ni mover.`
      : "Solo lectura: no puedes subir, mover ni borrar."
  }
- Usa archivos_listar o archivos_buscar para encontrarlos y archivo_leer para leerlos (extrae el texto de los PDF y las filas de CSV/XLSX).
- Son datos personales: usa solo lo necesario y no copies números de cuenta, DNI o similares completos a paneles o a la memoria.`;
});
