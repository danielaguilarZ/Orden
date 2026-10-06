import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { auditor, canWrite, clip, DailyLimit, guard, pickGrant, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Una carpeta de notas del PC (una bóveda de Obsidian, Logseq o simples
 * .md/.txt). Lectura: listar, buscar y leer. Completo: además crear notas o
 * añadir texto al final (nunca borra, mueve ni sobrescribe; máx. 50 al día).
 * Candado: solo .md/.txt, nada fuera de la carpeta (ni «..» ni enlaces que
 * salgan), sin carpetas ocultas (.obsidian, .git, .trash).
 */

const TEXT_EXT = new Set([".md", ".txt"]);
const MAX_READ = 20_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_WALK = 5000;
export const MAX_WRITE = 20_000;
export const notesLimit = new DailyLimit(50, "escrituras en la carpeta de notas");

const rootOf = (c: Connection) => String(c.config.carpeta);

/** Carpeta válida: absoluta, existente y que no sea la raíz de un disco. */
export function normalizeFolder(raw: string): string {
  const s = raw.trim().replace(/^"|"$/g, "");
  if (!s || !path.isAbsolute(s)) throw new Error("Escribe la ruta completa de la carpeta (p. ej. C:\\Users\\tu\\Documents\\Obsidian).");
  const abs = path.resolve(s);
  if (path.parse(abs).root === abs) throw new Error("No se puede conectar la raíz de un disco: elige la carpeta de tus notas.");
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`No existe la carpeta «${abs}».`);
  }
  if (!st.isDirectory()) throw new Error(`«${abs}» no es una carpeta.`);
  return abs;
}

const hidden = (name: string) => name.startsWith(".");

/**
 * Ruta relativa → absoluta dentro de la carpeta. Rechaza absolutas, «..»,
 * carpetas ocultas y cualquier cosa que (siguiendo enlaces) salga de la raíz.
 */
export function resolveInside(root: string, rel: string): string {
  const clean = rel.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!clean || clean === ".") return fs.realpathSync(root);
  if (path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) throw new Error("Usa rutas relativas a la carpeta de notas.");
  const parts = clean.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) throw new Error("La ruta no puede contener «..».");
  if (parts.some(hidden)) throw new Error("No se puede acceder a carpetas o archivos ocultos.");
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, ...parts);
  // El antepasado que exista, con enlaces resueltos, debe seguir dentro.
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error("Esa ruta sale de la carpeta de notas.");
  return target;
}

const rel = (root: string, abs: string) => path.relative(fs.realpathSync(root), abs).split(path.sep).join("/");
const isText = (p: string) => TEXT_EXT.has(path.extname(p).toLowerCase());

export function listFolder(root: string, sub = ""): string {
  const dir = resolveInside(root, sub);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No existe la carpeta «${sub}».`);
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !hidden(e.name) && (e.isDirectory() || isText(e.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  if (!entries.length) return `«${sub || "/"}» está vacía.`;
  const shown = entries.slice(0, 200).map((e) => (e.isDirectory() ? `- 📁 ${rel(root, path.join(dir, e.name))}/` : `- ${rel(root, path.join(dir, e.name))}`));
  return [...shown, ...(entries.length > 200 ? [`(… y ${entries.length - 200} más)`] : [])].join("\n");
}

/** Recorre la carpeta (sin ocultas, sin seguir enlaces de carpeta) hasta MAX_WALK archivos de texto. */
function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [fs.realpathSync(root)];
  while (stack.length && out.length < MAX_WALK) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (hidden(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && isText(e.name)) out.push(p);
    }
  }
  return out;
}

export function searchNotes(root: string, text: string, max = 20): string {
  const q = text.trim().toLowerCase();
  if (!q) throw new Error("Escribe qué buscar.");
  const hits: string[] = [];
  for (const file of walk(root)) {
    if (hits.length >= max) break;
    const name = rel(root, file);
    let line = "";
    if (!name.toLowerCase().includes(q)) {
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.toLowerCase().includes(q)) ?? "";
      } catch {
        continue;
      }
      if (!line) continue;
    }
    hits.push(`- ${name}${line ? `\n  …${clip(line.trim(), 200)}` : ""}`);
  }
  return hits.length ? hits.join("\n") : `Nada con «${text}».`;
}

export function readNote(root: string, file: string, from = 0): string {
  const abs = resolveInside(root, file);
  if (!isText(abs)) throw new Error("Solo se leen notas .md o .txt.");
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`No existe «${file}».`);
  if (fs.statSync(abs).size > MAX_FILE_BYTES) throw new Error("La nota es demasiado grande (máx. 2 MB).");
  const text = fs.readFileSync(abs, "utf8");
  const chunk = text.slice(from, from + MAX_READ);
  const more = from + MAX_READ < text.length ? `\n\n(… sigue: vuelve a leer con desde=${from + MAX_READ}; total ${text.length} caracteres)` : "";
  return (chunk || "(vacía)") + more;
}

/** Crea una nota nueva («crear») o añade al final («anadir», creándola si no existe). Nunca sobrescribe. */
export function writeNote(c: Connection, file: string, text: string, mode: "crear" | "anadir", at = new Date()): string {
  const root = rootOf(c);
  const body = text.replace(/\r\n/g, "\n");
  if (!body.trim()) throw new Error("No hay texto que escribir.");
  if (body.length > MAX_WRITE) throw new Error(`Demasiado texto de una vez (máx. ${MAX_WRITE} caracteres).`);
  const abs = resolveInside(root, file);
  if (path.extname(abs).toLowerCase() !== ".md" && path.extname(abs).toLowerCase() !== ".txt") throw new Error("Solo se escriben notas .md o .txt.");
  notesLimit.check(c.id, at);
  const exists = fs.existsSync(abs);
  if (exists && !fs.statSync(abs).isFile()) throw new Error(`«${file}» no es un archivo.`);
  if (mode === "crear" && exists) throw new Error(`Ya existe «${file}»: usa modo «anadir» o elige otro nombre.`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Revisión final por si una carpeta creada fuera un enlace.
  resolveInside(root, file);
  if (exists) {
    const prev = fs.readFileSync(abs, "utf8");
    fs.appendFileSync(abs, `${prev.endsWith("\n") || !prev ? "" : "\n"}\n${body}\n`, "utf8");
  } else fs.writeFileSync(abs, `${body}\n`, { encoding: "utf8", flag: "wx" });
  notesLimit.add(c.id, at);
  return rel(root, abs);
}

function obsidianTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = pickGrant(grants);
  const c = g.connection;
  const root = rootOf(c);
  const run = guard(c);
  const audit = auditor(ctx, c, "Notas locales");
  const tools: ToolDef[] = [
    defineTool("notas_listar", "Lista una carpeta de la bóveda de notas del usuario (rutas relativas; vacía = la raíz).", { carpeta: z.string().max(300).optional() }, async ({ carpeta }) =>
      run(async () => {
        audit(`lista «${carpeta ?? "/"}»`);
        return listFolder(root, carpeta ?? "");
      }),
    ),
    defineTool("notas_buscar", "Busca texto en los nombres y el contenido de las notas (.md/.txt).", { texto: z.string().min(1).max(200), max: z.number().int().min(1).max(100).optional() }, async ({ texto, max }) =>
      run(async () => {
        audit(`busca «${texto}»`);
        return searchNotes(root, texto, max ?? 20);
      }),
    ),
    defineTool(
      "notas_leer",
      `Lee una nota (ruta relativa). Devuelve hasta ${MAX_READ} caracteres; para seguir, usa «desde».`,
      { ruta: z.string().min(1).max(300), desde: z.number().int().min(0).optional() },
      async ({ ruta, desde }) =>
        run(async () => {
          audit(`lee «${ruta}»`);
          return readNote(root, ruta, desde ?? 0);
        }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "notas_escribir",
        `Crea una nota nueva (modo «crear») o añade texto al final de una (modo «anadir»; la crea si no existe). Nunca borra ni sobrescribe. Solo si te lo piden. Máx. ${MAX_WRITE} caracteres y ${notesLimit.max} escrituras al día.`,
        { ruta: z.string().min(1).max(300).describe("Relativa, p. ej. «Diario/2026-10-05.md»"), texto: z.string().min(1).max(MAX_WRITE), modo: z.enum(["crear", "anadir"]) },
        async ({ ruta, texto, modo }) =>
          run(async () => {
            const r = writeNote(c, ruta, texto, modo);
            audit(`${modo === "crear" ? "crea" : "añade a"} «${r}»`);
            ctx.note(`Notas: ${modo === "crear" ? "creada" : "ampliada"} ${r}`, { kind: "notas" });
            return `${modo === "crear" ? "Nota creada" : "Texto añadido"}: ${r}`;
          }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "obsidian",
  label: "Notas locales (Obsidian)",
  description: "Una carpeta de notas de tu PC (bóveda de Obsidian o .md/.txt): buscar y leer; con permiso completo, crear notas o añadir al final.",
  category: "notas",
  levels: {
    lectura: "Lectura: listar, buscar y leer notas .md/.txt",
    completo: `Completo: además crear notas o añadir texto al final (nunca borra ni sobrescribe; máx. ${notesLimit.max} al día)`,
  },
  fields: [{ key: "carpeta", label: "Ruta de la carpeta", placeholder: "C:\\Users\\tu\\Documents\\Obsidian\\Personal" }],
  supportsSecret: false,
  steps: [
    "Copia la ruta completa de tu bóveda de Obsidian (o de cualquier carpeta con notas .md/.txt). En Obsidian: «Abrir carpeta de la bóveda» y copia la ruta.",
    "Pégala aquí y pulsa «Añadir». Orden solo verá .md y .txt de esa carpeta (ni ocultas como .obsidian, ni nada fuera).",
    "Pulsa «Probar conexión»: verás cuántas notas hay.",
    "«Lectura» para buscar y leer; «Completo» para que también creen notas o añadan al final (p. ej. el diario).",
  ],
  normalizeConfig(input) {
    return { carpeta: normalizeFolder(String(input.carpeta ?? "")) };
  },
  defaultName(config) {
    return `Notas · ${path.basename(String(config.carpeta))}`;
  },
  tools: obsidianTools,
  prompt(grants) {
    return `Notas locales del usuario (rutas relativas a su carpeta): notas_listar, notas_buscar y notas_leer${canWrite(grants) ? "; notas_escribir (crear o añadir al final, nunca borra) solo si te lo piden" : ""}.`;
  },
  test(c) {
    return testWith(c, async () => {
      normalizeFolder(rootOf(c));
      const n = walk(rootOf(c)).length;
      return `Carpeta accesible: ${n >= MAX_WALK ? `${MAX_WALK} o más` : n} nota(s) .md/.txt.`;
    });
  },
});
