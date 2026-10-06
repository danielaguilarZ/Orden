import { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../agents/tools";
import { TIMEZONE } from "../agents/prompt";
import type { Connection } from "../repo/connections";
import { redact } from "../secrets";
import { fetchText } from "./http";
import { auditor, guard, requireSecret, testWith } from "./kit";
import { addDays, dateToLocal, daysBetween, isDay, localToDate, todayIn } from "./google/time";
import { registerService, type AgentGrant } from "./registry";

/**
 * Cualquier calendario por su dirección iCal/ICS (Outlook, iCloud, Google
 * «dirección secreta», Calendly, festivos…). Solo lectura: los agentes lo
 * consultan con ics_eventos. La dirección va cifrada (las privadas llevan un token).
 */

const SECRET = "dirección del calendario";
const MAX_OCCURRENCES = 2000;

// ---------- Lectura del formato iCalendar (RFC 5545), sin dependencias ----------

interface Prop {
  value: string;
  params: Record<string, string>;
}
export interface RawEvent {
  uid: string;
  summary: string;
  start: Prop;
  end?: Prop;
  duration?: string;
  rrule?: string;
  exdates: Prop[];
  recurrenceId?: Prop;
  location?: string;
  description?: string;
  cancelled: boolean;
}

const unescape = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

/** Líneas desplegadas («folding») y separadas en nombre, parámetros y valor. */
function lines(text: string): { name: string; params: Record<string, string>; value: string }[] {
  const out: { name: string; params: Record<string, string>; value: string }[] = [];
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (i <= 0) continue;
    const [name, ...rawParams] = line.slice(0, i).split(";");
    const params: Record<string, string> = {};
    for (const p of rawParams) {
      const [k, v = ""] = p.split("=");
      params[k.toUpperCase()] = v.replace(/^"|"$/g, "");
    }
    out.push({ name: name.toUpperCase(), params, value: line.slice(i + 1) });
  }
  return out;
}

/** Eventos (VEVENT) de un archivo .ics. */
export function parseIcs(text: string): RawEvent[] {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("La dirección no devuelve un calendario iCal (.ics).");
  const events: RawEvent[] = [];
  let cur: Partial<RawEvent> | null = null;
  let depth = 0;
  for (const l of lines(text)) {
    if (l.name === "BEGIN" && l.value.toUpperCase() === "VEVENT") {
      cur = { exdates: [], cancelled: false };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (l.name === "BEGIN") depth++;
    else if (l.name === "END" && l.value.toUpperCase() !== "VEVENT") depth--;
    else if (l.name === "END") {
      if (cur.start) events.push({ uid: cur.uid ?? `${cur.summary}-${cur.start.value}`, summary: cur.summary ?? "(sin título)", ...cur } as RawEvent);
      cur = null;
    } else if (depth === 0) {
      const p = { value: l.value.trim(), params: l.params };
      if (l.name === "UID") cur.uid = l.value.trim();
      else if (l.name === "SUMMARY") cur.summary = unescape(l.value) || "(sin título)";
      else if (l.name === "DTSTART") cur.start = p;
      else if (l.name === "DTEND") cur.end = p;
      else if (l.name === "DURATION") cur.duration = l.value.trim();
      else if (l.name === "RRULE") cur.rrule = l.value.trim();
      else if (l.name === "EXDATE") for (const v of l.value.split(",")) cur.exdates!.push({ value: v.trim(), params: l.params });
      else if (l.name === "RECURRENCE-ID") cur.recurrenceId = p;
      else if (l.name === "LOCATION") cur.location = unescape(l.value);
      else if (l.name === "DESCRIPTION") cur.description = unescape(l.value);
      else if (l.name === "STATUS") cur.cancelled = l.value.trim().toUpperCase() === "CANCELLED";
    }
  }
  return events;
}

/** Zona válida para Intl (las de Windows, como «Romance Standard Time», no lo son: se usa la del usuario). */
function zoneOr(tzid: string | undefined, tz: string): string {
  if (!tzid) return tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tzid });
    return tzid;
  } catch {
    return tz;
  }
}

/** Momento de una propiedad: día (todo el día) o instante. */
type When = { day: string; time: string | null; zone: string };

export function readWhen(p: Prop, tz: string): When {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value);
  if (!m) throw new Error(`Fecha iCal no válida: «${p.value}».`);
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || p.params.VALUE === "DATE") return { day, time: null, zone: tz };
  return { day, time: `${m[4]}:${m[5]}`, zone: m[7] ? "UTC" : zoneOr(p.params.TZID, tz) };
}

const instant = (w: When) => (w.time ? localToDate(`${w.day}T${w.time}`, w.zone).getTime() : localToDate(w.day, w.zone).getTime());

/** DURATION de iCal (P1DT2H30M, PT45M, P1W) → milisegundos. */
export function durationMs(d: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return 0;
  const [, sign, w, dd, h, mi, s] = m;
  const ms = ((Number(w ?? 0) * 7 + Number(dd ?? 0)) * 86_400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const dow = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const monthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Días del mes que cumplen BYDAY con ordinal («2TU», «-1FR») o sin él («MO»). */
function monthByDay(y: number, m: number, byday: string[]): number[] {
  const n = monthDays(y, m);
  const out: number[] = [];
  for (const b of byday) {
    const mm = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(b);
    if (!mm) continue;
    const wd = WEEKDAYS.indexOf(mm[2]);
    const all = Array.from({ length: n }, (_, i) => i + 1).filter((d) => dow(ymd(y, m, d)) === wd);
    const ord = mm[1] ? Number(mm[1]) : 0;
    if (!ord) out.push(...all);
    else if (ord > 0 && all[ord - 1]) out.push(all[ord - 1]);
    else if (ord < 0 && all[all.length + ord]) out.push(all[all.length + ord]);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Días (en la hora de pared del evento) en que cae una regla RRULE, desde el
 * primero y sin pasar de `untilDay`. Admite DAILY, WEEKLY (BYDAY), MONTHLY
 * (BYMONTHDAY o BYDAY con ordinal), YEARLY, INTERVAL, COUNT y UNTIL.
 */
export function expandDays(startDay: string, rrule: string, untilDay: string, untilInstant: (day: string) => boolean): string[] {
  const r = Object.fromEntries(rrule.split(";").map((kv) => kv.split("=") as [string, string]));
  const freq = (r.FREQ ?? "").toUpperCase();
  const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const byday = r.BYDAY ? r.BYDAY.toUpperCase().split(",") : [];
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : [];
  const out: string[] = [];
  const push = (day: string) => {
    if (day < startDay || out.length >= count || out.length >= MAX_OCCURRENCES) return;
    if (day > untilDay || !untilInstant(day)) return;
    out.push(day);
  };
  const [y0, m0, d0] = startDay.split("-").map(Number);
  const done = (day: string) => day > untilDay || out.length >= count || out.length >= MAX_OCCURRENCES;
  if (freq === "DAILY") {
    for (let day = startDay; !done(day); day = addDays(day, interval)) push(day);
  } else if (freq === "WEEKLY") {
    const days = byday.length ? byday.map((b) => WEEKDAYS.indexOf(b.slice(-2))).filter((x) => x >= 0) : [dow(startDay)];
    // Semanas desde el lunes de la semana del primero.
    let monday = addDays(startDay, -((dow(startDay) + 6) % 7));
    while (!done(monday)) {
      for (const wd of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) push(addDays(monday, (wd + 6) % 7));
      monday = addDays(monday, 7 * interval);
    }
  } else if (freq === "MONTHLY") {
    for (let i = 0; ; i += interval) {
      const y = y0 + Math.floor((m0 - 1 + i) / 12);
      const m = ((m0 - 1 + i) % 12) + 1;
      if (ymd(y, m, 1) > untilDay || out.length >= count || out.length >= MAX_OCCURRENCES) break;
      const n = monthDays(y, m);
      const days = bymonthday.length ? bymonthday.map((d) => (d < 0 ? n + d + 1 : d)).filter((d) => d >= 1 && d <= n) : byday.length ? monthByDay(y, m, byday) : d0 <= n ? [d0] : [];
      for (const d of [...new Set(days)].sort((a, b) => a - b)) push(ymd(y, m, d));
    }
  } else if (freq === "YEARLY") {
    for (let y = y0; ymd(y, 1, 1) <= untilDay && out.length < count && out.length < MAX_OCCURRENCES; y += interval) {
      if (d0 <= monthDays(y, m0)) push(ymd(y, m0, d0));
    }
  } else {
    push(startDay);
  }
  return out;
}

export interface Occurrence {
  uid: string;
  title: string;
  /** Hora local del usuario: AAAA-MM-DD (todo el día) o AAAA-MM-DDTHH:MM. */
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  notes?: string;
}

/** Ocurrencias que tocan [from, toExclusive) (días en la zona del usuario), ordenadas. */
export function occurrences(events: RawEvent[], from: string, toExclusive: string, tz = TIMEZONE): Occurrence[] {
  const fromMs = localToDate(from, tz).getTime();
  const toMs = localToDate(toExclusive, tz).getTime();
  const overrides = new Map<string, Set<number>>();
  for (const e of events) {
    if (!e.recurrenceId) continue;
    const set = overrides.get(e.uid) ?? new Set<number>();
    set.add(instant(readWhen(e.recurrenceId, tz)));
    overrides.set(e.uid, set);
  }
  const out: Occurrence[] = [];
  for (const e of events) {
    const start = readWhen(e.start, tz);
    const end = e.end ? readWhen(e.end, tz) : null;
    const allDay = start.time === null;
    const lenMs = end ? instant(end) - instant(start) : e.duration ? durationMs(e.duration) : allDay ? 86_400_000 : 0;
    const exdates = new Set(e.exdates.map((x) => instant(readWhen(x, tz))));
    const skip = e.recurrenceId ? new Set<number>() : (overrides.get(e.uid) ?? new Set<number>());
    let days = [start.day];
    if (e.rrule && !e.recurrenceId) {
      const until = /UNTIL=([0-9TZ]+)/i.exec(e.rrule)?.[1];
      // UNTIL con solo fecha incluye ese día entero.
      const u = until ? readWhen({ value: until, params: {} }, start.zone) : null;
      const untilMs = u ? instant(u) + (u.time ? 0 : 86_400_000 - 1) : Infinity;
      // Margen de 1 día por las zonas horarias; el filtro fino va abajo.
      const lastDay = addDays(dateToLocal(new Date(toMs), start.zone).slice(0, 10), 1);
      days = expandDays(start.day, e.rrule, lastDay, (d) => instant({ ...start, day: d }) <= untilMs);
    }
    for (const day of days) {
      const w = { ...start, day };
      const s = instant(w);
      if (exdates.has(s) || skip.has(s) || e.cancelled) continue;
      const eMs = s + Math.max(0, lenMs);
      if (!(s < toMs && (eMs > fromMs || (eMs === s && s >= fromMs)))) continue;
      const occ: Occurrence = { uid: e.uid, title: e.summary, allDay, start: "" };
      if (allDay) {
        occ.start = day;
        const last = addDays(day, Math.max(1, Math.round(lenMs / 86_400_000)) - 1);
        if (last > day) occ.end = last;
      } else {
        occ.start = dateToLocal(new Date(s), tz);
        if (eMs > s) occ.end = dateToLocal(new Date(eMs), tz);
      }
      if (e.location) occ.location = e.location;
      if (e.description) occ.notes = e.description.length > 1000 ? `${e.description.slice(0, 1000)}…` : e.description;
      out.push(occ);
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// ---------- Conexión ----------

/** webcal:// → https://; solo http(s). */
export function icsUrl(raw: string): string {
  const s = raw.trim().replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("La dirección del calendario no es válida.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("La dirección del calendario debe ser http(s) o webcal.");
  return u.href;
}

export async function fetchIcs(c: Connection): Promise<RawEvent[]> {
  const url = icsUrl(requireSecret(c, SECRET));
  try {
    return parseIcs(await fetchText(url, { headers: { Accept: "text/calendar, */*" } }, { secrets: [url], maxBytes: 8_000_000 }));
  } catch (err) {
    throw new Error(redact((err as Error).message, url));
  }
}

export const occurrenceLine = (o: Occurrence) =>
  `- ${o.start.replace("T", " ")}${o.end ? ` → ${o.end.replace("T", " ")}` : ""}${o.allDay ? " (todo el día)" : ""} · ${o.title}${o.location ? ` · ${o.location}` : ""}`;

export async function eventsText(c: Connection, from: string, to: string, text?: string): Promise<string> {
  if (!isDay(from) || !isDay(to)) throw new Error("Fechas no válidas: usa AAAA-MM-DD.");
  if (to < from) throw new Error("«hasta» va antes que «desde».");
  if (daysBetween(from, to) > 93) throw new Error("Rango demasiado largo (máx. 93 días).");
  const q = text?.trim().toLowerCase();
  const list = occurrences(await fetchIcs(c), from, addDays(to, 1)).filter((o) => !q || `${o.title} ${o.location ?? ""} ${o.notes ?? ""}`.toLowerCase().includes(q));
  if (!list.length) return `Sin eventos del ${from} al ${to}${q ? ` con «${text}»` : ""} en «${c.name}».`;
  return [`${list.length} evento(s) en «${c.name}» del ${from} al ${to}:`, ...list.slice(0, 200).map(occurrenceLine)].join("\n");
}

function icsTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const names = grants.map((g) => g.connection.name);
  return [
    defineTool(
      "ics_eventos",
      `Eventos de los calendarios iCal conectados (${names.join(", ")}) entre dos fechas (máx. 93 días). Sin fechas: los próximos 7 días.`,
      {
        desde: z.string().optional().describe("AAAA-MM-DD (por defecto, hoy)"),
        hasta: z.string().optional().describe("AAAA-MM-DD, inclusive (por defecto, dentro de 7 días)"),
        texto: z.string().max(100).optional(),
        calendario: z.string().max(100).optional().describe("Nombre de la conexión (por defecto, todas)"),
      },
      async ({ desde, hasta, texto, calendario }) => {
        const from = desde ?? todayIn(TIMEZONE);
        const to = hasta ?? addDays(from, 7);
        const chosen = grants.filter((g) => !calendario || g.connection.name.toLowerCase().includes(calendario.toLowerCase()));
        if (!chosen.length) return fail(`No hay ningún calendario «${calendario}». Hay: ${names.join(", ")}.`);
        const results = [];
        for (const g of chosen) {
          results.push(
            await guard(g.connection)(async () => {
              auditor(ctx, g.connection, "iCal")(`lee eventos del ${from} al ${to}`);
              return eventsText(g.connection, from, to, texto);
            }),
          );
        }
        if (results.length === 1) return results[0];
        return { ...ok(results.map((r) => r.content[0].text).join("\n\n")), isError: results.every((r) => "isError" in r && r.isError) || undefined };
      },
    ),
  ];
}

registerService({
  key: "ics",
  label: "Calendario iCal (URL)",
  description: "Cualquier calendario por su dirección .ics (Outlook, iCloud, Google, festivos, reservas…). Solo lectura: los agentes consultan sus eventos.",
  category: "agenda",
  readOnly: true,
  levels: { lectura: "Lectura: ver los eventos del calendario", completo: "Completo: igual que lectura (no se escribe nada)" },
  fields: [{ key: "nombre", label: "Nombre", placeholder: "Trabajo (Outlook)" }],
  supportsSecret: true,
  secretLabel: "Dirección del calendario (.ics)",
  secretPlaceholder: "https://…/calendar.ics o webcal://…",
  steps: [
    "Copia la dirección iCal de tu calendario: Outlook → Configuración → Calendarios compartidos → «Publicar» (ICS); Google → Configuración del calendario → «Dirección secreta en formato iCal»; iCloud → compartir → «Calendario público».",
    "Pon un nombre y pulsa «Añadir»; pega la dirección en la ficha (se guarda cifrada: las privadas llevan una clave).",
    "Pulsa «Probar conexión»: verás cuántos eventos tiene.",
    "Da permiso de lectura a los agentes que lleven tu agenda.",
  ],
  normalizeConfig(input) {
    const nombre = String(input.nombre ?? "").trim().slice(0, 60) || "Calendario iCal";
    return { nombre };
  },
  defaultName(config) {
    return String(config.nombre);
  },
  tools: icsTools,
  prompt(grants) {
    return `Calendarios iCal (solo lectura): ics_eventos (${grants.map((g) => g.connection.name).join(", ")}).`;
  },
  test(c) {
    return testWith(
      c,
      async () => {
        const events = await fetchIcs(c);
        const today = todayIn(TIMEZONE);
        const next = occurrences(events, today, addDays(today, 31));
        return `Calendario leído: ${events.length} evento(s) en el archivo, ${next.length} en los próximos 30 días${next[0] ? ` (el primero: ${occurrenceLine(next[0]).slice(2)})` : ""}.`;
      },
      SECRET,
    );
  },
});
