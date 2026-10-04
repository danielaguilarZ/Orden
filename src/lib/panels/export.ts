import { strToU8, zipSync } from "fflate";
import {
  tableTotals,
  type CalendarData,
  type ChartData,
  type HabitsData,
  type KanbanData,
  type ListData,
  type NotesData,
  type TableData,
} from "./types";

/**
 * Exportadores de paneles (funciones puras): Markdown, CSV, Excel e iCalendar.
 * Un tipo nuevo solo tiene que añadir sus filas o su Markdown aquí.
 */

export type ExportFormat = "md" | "csv" | "xlsx" | "ics";

export interface ExportablePanel {
  type: string;
  title: string;
  data: unknown;
}

/** Formatos que admite cada tipo de panel. */
export function formatsFor(type: string): ExportFormat[] {
  const out: ExportFormat[] = ["md"];
  if (type !== "notas") out.push("csv", "xlsx");
  if (type === "calendario") out.push("ics");
  return out;
}

type Cell = string | number | boolean | null;

/** Tabla genérica (cabecera + filas) para CSV y Excel. */
export function toRows(p: ExportablePanel): Cell[][] {
  switch (p.type) {
    case "tabla": {
      const d = p.data as TableData;
      const rows: Cell[][] = [d.columns.map((c) => c.label), ...d.rows.map((r) => d.columns.map((c) => r.cells[c.key] ?? null))];
      const totals = tableTotals(d);
      if (Object.keys(totals).length) rows.push(d.columns.map((c, i) => (c.key in totals ? totals[c.key] : i === 0 ? "Total" : null)));
      return rows;
    }
    case "lista": {
      const d = p.data as ListData;
      return [["Hecho", "Elemento", "Fecha", "Notas"], ...d.items.map((i) => [i.done, i.text, i.due ?? null, i.notes ?? null])];
    }
    case "kanban": {
      const d = p.data as KanbanData;
      return [
        ["Columna", "Tarjeta", "Prioridad", "Fecha límite", "Etiquetas", "Notas"],
        ...d.columns.flatMap((c) => c.cards.map((k) => [c.title, k.title, k.priority ?? null, k.due ?? null, (k.tags ?? []).join(", ") || null, k.notes ?? null])),
      ];
    }
    case "calendario": {
      const d = p.data as CalendarData;
      return [
        ["Título", "Inicio", "Fin", "Todo el día", "Lugar", "Notas"],
        ...[...d.events]
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((e) => [e.title, e.start.replace("T", " "), e.end?.replace("T", " ") ?? null, Boolean(e.allDay), e.location ?? null, e.notes ?? null]),
      ];
    }
    case "grafico": {
      const d = p.data as ChartData;
      return [["Etiqueta", ...d.series.map((s) => s.name)], ...d.labels.map((l, i) => [l, ...d.series.map((s) => s.values[i] ?? null)])];
    }
    case "habitos": {
      const d = p.data as HabitsData;
      const dates = [...new Set(d.habits.flatMap((h) => Object.keys(h.log)))].sort();
      return [["Hábito", ...dates], ...d.habits.map((h) => [h.name, ...dates.map((dt) => h.log[dt] ?? null)])];
    }
    case "notas":
      return [["Notas"], [(p.data as NotesData).markdown]];
    default:
      return [["Datos"], [JSON.stringify(p.data)]];
  }
}

// ───────────────────────── CSV ─────────────────────────

export function toCsv(p: ExportablePanel): string {
  const esc = (v: Cell) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "boolean" ? (v ? "sí" : "no") : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Punto y coma y BOM: así Excel en español lo abre bien a la primera.
  return "\uFEFF" + toRows(p).map((r) => r.map(esc).join(";")).join("\r\n") + "\r\n";
}

// ───────────────────────── Markdown ─────────────────────────

function mdTable(rows: Cell[][]): string {
  if (!rows.length) return "";
  const cell = (v: Cell) => (v === null ? "" : typeof v === "boolean" ? (v ? "✓" : "") : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "));
  const [head, ...body] = rows;
  return [`| ${head.map(cell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

export function toMarkdown(p: ExportablePanel): string {
  const title = `# ${p.title}\n\n`;
  switch (p.type) {
    case "notas":
      return title + (p.data as NotesData).markdown + "\n";
    case "lista": {
      const d = p.data as ListData;
      return title + d.items.map((i) => (d.checkable ? `- [${i.done ? "x" : " "}] ${i.text}` : `- ${i.text}`) + (i.due ? ` _(${i.due})_` : "")).join("\n") + "\n";
    }
    case "kanban": {
      const d = p.data as KanbanData;
      return (
        title +
        d.columns
          .map((c) => `## ${c.title}\n\n${c.cards.map((k) => `- ${k.title}${k.priority ? ` · prioridad ${k.priority}` : ""}${k.due ? ` · ${k.due}` : ""}`).join("\n") || "_(vacía)_"}`)
          .join("\n\n") +
        "\n"
      );
    }
    case "calendario": {
      const d = p.data as CalendarData;
      const byDay = new Map<string, typeof d.events>();
      for (const e of [...d.events].sort((a, b) => a.start.localeCompare(b.start))) {
        const k = e.start.slice(0, 10);
        byDay.set(k, [...(byDay.get(k) ?? []), e]);
      }
      return (
        title +
        [...byDay.entries()]
          .map(([day, evs]) => `## ${day}\n\n${evs.map((e) => `- ${e.allDay || !e.start.includes("T") ? "Todo el día" : e.start.slice(11)}${e.end?.includes("T") ? `–${e.end.slice(11)}` : ""} · ${e.title}${e.location ? ` (${e.location})` : ""}`).join("\n")}`)
          .join("\n\n") +
        "\n"
      );
    }
    default:
      return title + mdTable(toRows(p)) + "\n";
  }
}

// ───────────────────────── Excel (.xlsx) ─────────────────────────

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i: number): string {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Un .xlsx mínimo y válido (una hoja, cabecera en negrita) sin dependencias pesadas. */
export function toXlsx(p: ExportablePanel): Uint8Array {
  const rows = toRows(p);
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          const style = ri === 0 ? ' s="1"' : "";
          if (v === null || v === undefined || v === "") return "";
          if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
          if (typeof v === "boolean") return `<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`;
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const widths = (rows[0] ?? []).map((_, ci) => Math.min(60, Math.max(10, ...rows.map((r) => String(r[ci] ?? "").length + 2))));
  const sheetName = xmlEsc(p.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Hoja1");

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : ""}<sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  };
  return zipSync(files);
}

// ───────────────────────── iCalendar (.ics) ─────────────────────────

function icsText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Corta líneas a 75 octetos como pide RFC 5545. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const icsDate = (s: string) => s.slice(0, 10).replace(/-/g, "");
const icsDateTime = (s: string) => `${icsDate(s)}T${s.slice(11, 16).replace(":", "")}00`;

function addDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + 1));
  return x.toISOString().slice(0, 10);
}

/**
 * Calendario en formato .ics. Las horas van como «hora local flotante»
 * (sin zona): el calendario que lo importe las pone en tu zona.
 */
export function toIcs(p: ExportablePanel, opts: { id?: string; now?: Date } = {}): string {
  const d = p.data as CalendarData;
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Orden//Paneles//ES", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsText(p.title)}`];
  for (const e of d.events) {
    const allDay = e.allDay || !e.start.includes("T");
    lines.push("BEGIN:VEVENT", `UID:${e.id}-${opts.id ?? "panel"}@orden.local`, `DTSTAMP:${stamp}`);
    if (allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.start)}`, `DTEND;VALUE=DATE:${icsDate(addDay((e.end ?? e.start).slice(0, 10)))}`);
    } else {
      lines.push(`DTSTART:${icsDateTime(e.start)}`);
      if (e.end?.includes("T")) lines.push(`DTEND:${icsDateTime(e.end)}`);
      else lines.push("DURATION:PT1H");
    }
    lines.push(`SUMMARY:${icsText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsText(e.notes)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function exportPanel(p: ExportablePanel, format: ExportFormat, opts: { id?: string } = {}): { body: Uint8Array | string; mime: string } {
  if (!formatsFor(p.type).includes(format)) throw new Error(`Un panel de tipo ${p.type} no se puede exportar a .${format}.`);
  switch (format) {
    case "md":
      return { body: toMarkdown(p), mime: "text/markdown; charset=utf-8" };
    case "csv":
      return { body: toCsv(p), mime: "text/csv; charset=utf-8" };
    case "xlsx":
      return { body: toXlsx(p), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    case "ics":
      return { body: toIcs(p, opts), mime: "text/calendar; charset=utf-8" };
  }
}

/** Nombre de archivo seguro a partir del título. */
export function fileSlug(title: string): string {
  return (
    title
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "panel"
  );
}
