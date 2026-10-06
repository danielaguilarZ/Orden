import { TIMEZONE } from "../../agents/prompt";
import type { Connection } from "../../repo/connections";
import { CalendarReader, type GEvent } from "./api";
import { localToDate } from "./time";

/**
 * Lectura de Google Calendar para las herramientas de los agentes (solo
 * lectura). Ya no se vuelca a ningún panel: los agentes consultan la agenda
 * cuando la necesitan con google_calendario_eventos.
 */

/** Descripción de Google (a veces HTML) → texto plano corto. */
export function plainText(html: string | undefined, max = 1000): string | undefined {
  if (!html?.trim()) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Calendarios configurados (por defecto, el principal). */
export const calendarsOf = (c: Connection): string[] => {
  const list = Array.isArray(c.config.calendars) ? (c.config.calendars as string[]) : [];
  return list.length ? list : ["primary"];
};

/** Lee los eventos de los calendarios de la conexión entre dos días (hasta exclusivo). */
export async function fetchEvents(c: Connection, from: string, toExclusive: string, opts: { calendars?: string[]; q?: string; max?: number } = {}) {
  const reader = new CalendarReader(c.id);
  const min = localToDate(from, TIMEZONE);
  const max = localToDate(toExclusive, TIMEZONE);
  const out: { calendar: string; event: GEvent }[] = [];
  for (const cal of opts.calendars ?? calendarsOf(c)) {
    for (const event of await reader.events(cal, min, max, { q: opts.q, max: opts.max })) out.push({ calendar: cal, event });
  }
  return out;
}
