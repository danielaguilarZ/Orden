import { unzipSync } from "fflate";
import { extractPdfText } from "./pdf";
import { fileTypeOf } from "./rules";

/**
 * Lectura del contenido de un archivo para los agentes (y para la vista
 * «Texto extraído»): texto de PDF, tablas de CSV/XLSX y texto plano.
 */

// ───────────── Texto ─────────────

/** UTF-8 si es válido; si no, Windows-1252 (CSV de bancos españoles exportados desde Excel). */
export function decodeText(data: Uint8Array): string {
  let bytes = data;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      return Buffer.from(bytes).toString("latin1");
    }
  }
}

// ───────────── CSV ─────────────

/** Separador más probable (; , tabulador o |) mirando las primeras líneas fuera de comillas. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 5000);
  const counts: Record<string, number> = { ";": 0, ",": 0, "\t": 0, "|": 0 };
  let quoted = false;
  for (const ch of sample) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ",";
}

/** CSV con comillas («"a;b"», «""» escapadas) y saltos de línea dentro de campos. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ───────────── XLSX ─────────────

export interface Sheet {
  name: string;
  rows: string[][];
}

const MAX_UNZIPPED = 200 * 1024 * 1024;
const MAX_ROWS = 50_000;

function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = xmlDecode(m[2]);
  return out;
}

/** Texto de un <si> o <is>: todos los <t>, sin la guía fonética (<rPh>). */
function richText(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  return [...clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join("");
}

/** «AB12» → 27 (columna, desde 0). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(id: number, custom: Map<number, string>): boolean {
  if (BUILTIN_DATE_FORMATS.has(id)) return true;
  const code = custom.get(id);
  if (!code) return false;
  const cleaned = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dy]/i.test(cleaned) || /h{1,2}[^a-z]*m/i.test(cleaned);
}

/** Número de serie de Excel → «AAAA-MM-DD» (o con hora si la tiene). */
export function excelDate(serial: number, date1904 = false): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86_400_000) + Date.UTC(1899, 11, 30);
  const iso = new Date(ms).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function formatNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Number(n.toPrecision(15)));
}

/** Lee todas las hojas de un .xlsx (valores, no fórmulas). Protegido contra «zip bombs». */
export function parseXlsx(data: Uint8Array): Sheet[] {
  let total = 0;
  const files = unzipSync(data, {
    filter: (f) => {
      if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error("La hoja de cálculo es demasiado grande para leerla.");
      return true;
    },
  });
  const text = (name: string) => (files[name] ? Buffer.from(files[name]).toString("utf8") : "");
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("No parece un .xlsx válido (falta xl/workbook.xml).");
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);

  const rels = new Map<string, string>();
  for (const m of text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.Id && a.Target) rels.set(a.Id, a.Target.startsWith("/") ? a.Target.slice(1) : `xl/${a.Target.replace(/^\.\//, "")}`);
  }

  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => richText(m[1] ?? ""));

  const styles = text("xl/styles.xml");
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrs(m[0]);
    custom.set(Number(a.numFmtId), a.formatCode ?? "");
  }
  const xfBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const dateStyle = [...xfBlock.matchAll(/<xf\b[^>]*>/g)].map((m) => isDateFormat(Number(attrs(m[0]).numFmtId ?? 0), custom));

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const target = rels.get(a["r:id"] ?? "") ?? "";
    const xml = text(target);
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (rows.length >= MAX_ROWS) break;
      const row: string[] = [];
      let next = 0;
      for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(c[1]);
        const col = ca.r ? columnIndex(ca.r) : next;
        next = col + 1;
        const inner = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (ca.t === "s") value = shared[Number(v)] ?? "";
        else if (ca.t === "inlineStr") value = richText(inner);
        else if (ca.t === "b") value = v === "1" ? "VERDADERO" : "FALSO";
        else if (ca.t === "str" || ca.t === "e") value = xmlDecode(v ?? "");
        else if (v !== undefined) value = dateStyle[Number(ca.s ?? 0)] && Number.isFinite(Number(v)) ? excelDate(Number(v), date1904) : formatNumber(v);
        if (col >= 0 && col < 16_384) row[col] = value;
      }
      const filled = Array.from(row, (x) => x ?? "");
      while (filled.length && filled[filled.length - 1].trim() === "") filled.pop();
      if (filled.length) rows.push(filled);
    }
    sheets.push({ name: a.name ?? `Hoja ${sheets.length + 1}`, rows });
  }
  return sheets;
}

// ───────────── Todo junto ─────────────

export interface Extracted {
  /** Texto listo para un agente. */
  text: string;
  /** «PDF», «CSV»… para la cabecera. */
  label: string;
  /** Páginas (PDF), filas (CSV) u hojas (XLSX). */
  detail: string;
  warning?: string;
}

const cell = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();
const tableText = (rows: string[][]) => rows.map((r) => r.map(cell).join(" | ")).join("\n");

/** Contenido legible de un archivo según su tipo. */
export function extractText(name: string, data: Uint8Array): Extracted {
  const type = fileTypeOf(name);
  switch (type?.category) {
    case "pdf": {
      const { pages, warning } = extractPdfText(data);
      const text = pages.map((p, i) => `--- Página ${i + 1} ---\n${p}`).join("\n\n");
      return { text, label: "PDF", detail: `${pages.length} página(s)`, warning };
    }
    case "csv": {
      const raw = decodeText(data);
      const rows = parseCsv(raw, name.toLowerCase().endsWith(".tsv") ? "\t" : undefined);
      return { text: tableText(rows), label: "CSV", detail: `${rows.length} fila(s), columnas separadas por « | »` };
    }
    case "xlsx": {
      const sheets = parseXlsx(data);
      const text = sheets.map((s) => `## Hoja «${s.name}» (${s.rows.length} filas)\n${tableText(s.rows)}`).join("\n\n");
      const truncated = sheets.some((s) => s.rows.length >= MAX_ROWS);
      return {
        text,
        label: "XLSX",
        detail: `${sheets.length} hoja(s), columnas separadas por « | »`,
        warning: truncated ? `Solo se leen las primeras ${MAX_ROWS.toLocaleString("es-ES")} filas de cada hoja.` : undefined,
      };
    }
    case "texto":
      return { text: decodeText(data), label: "Texto", detail: "" };
    case "imagen":
      return { text: "", label: "Imagen", detail: "", warning: "Es una imagen: no tiene texto que leer (no hay OCR)." };
    default:
      return { text: "", label: "Desconocido", detail: "", warning: "Tipo de archivo no admitido." };
  }
}

/**
 * Caché pequeña por id y versión. Los archivos de «Daily» se pueden reescribir:
 * la versión (fecha de cambio y tamaño) invalida lo extraído antes, también en
 * otro proceso (la interfaz y el worker tienen cada uno su caché).
 */
const cache = new Map<string, Extracted>();
export function extractCached(id: string, name: string, load: () => Uint8Array, version = ""): Extracted {
  const key = `${id}|${version}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}|`)) cache.delete(k);
  const out = extractText(name, load());
  cache.set(key, out);
  while (cache.size > 12) cache.delete(cache.keys().next().value!);
  return out;
}

/** Versión de un archivo para la caché de texto extraído. */
export const contentVersion = (n: { updatedAt: string; size: number }): string => `${n.updatedAt}:${n.size}`;
