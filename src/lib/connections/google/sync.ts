import { TIMEZONE } from "../../agents/prompt";
import type { CalendarData, CalendarEvent } from "../../panels/types";
import { createPanel, getPanel, listPanels, replacePanelData, type Actor } from "../../repo/panels";
import { markSync, updateConnection, type Connection } from "../../repo/connections";
import { logActivity } from "../../repo/system";
import { redact } from "../../secrets";
import { CalendarReader, readGoogleSecret, type GEvent } from "./api";
import { addDays, dateToLocal, localToDate, todayIn } from "./time";

/**
 * Volcado de Google Calendar a un panel «calendario» de Orden.
 * - Cada evento entra con id `gcal_<id del evento de Google>`: volver a volcar
 *   actualiza en vez de duplicar.
 * - Lo que se borró en Google desaparece del panel (solo eventos `gcal_`
 *   dentro de la ventana volcada). Los eventos creados a mano no se tocan.
 * - Solo se guarda versión del panel si algo cambia.
 */

export const SYNC_EVERY_MS = 30 * 60_000;
/** Ventana del volcado automático: desde hace 7 días hasta dentro de 60. */
export const WINDOW_PAST_DAYS = 7;
export const WINDOW_FUTURE_DAYS = 60;
export const ID_PREFIX = "gcal_";
const SYSTEM_ACTOR: Actor = { by: "sistema" };

export const panelEventId = (googleId: string) => `${ID_PREFIX}${googleId}`;

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

/** Evento de Google → evento del panel (hora local; fin de día completo inclusivo). */
export function toPanelEvent(e: GEvent, tz = TIMEZONE): CalendarEvent | null {
  if (!e.id) return null;
  const base = { id: panelEventId(e.id), title: e.summary?.trim() || "(sin título)" } as CalendarEvent;
  if (e.start.date) {
    base.start = e.start.date;
    base.allDay = true;
    // Google da el fin exclusivo; el panel lo guarda inclusivo.
    const last = e.end?.date ? addDays(e.end.date, -1) : e.start.date;
    if (last > e.start.date) base.end = last;
  } else if (e.start.dateTime) {
    base.start = dateToLocal(new Date(e.start.dateTime), tz);
    base.allDay = false;
    if (e.end?.dateTime) base.end = dateToLocal(new Date(e.end.dateTime), tz);
  } else return null;
  if (e.location?.trim()) base.location = e.location.trim();
  const notes = plainText(e.description);
  if (notes) base.notes = notes;
  return base;
}

const same = (a: CalendarEvent, b: CalendarEvent) =>
  a.title === b.title && a.start === b.start && a.end === b.end && Boolean(a.allDay) === Boolean(b.allDay) && a.location === b.location && a.notes === b.notes;

export interface MergeResult {
  data: CalendarData;
  added: number;
  updated: number;
  removed: number;
}

/**
 * Mezcla pura: añade o actualiza por id y quita los `gcal_` de la ventana
 * [from, toExclusive) que ya no vienen de Google. Conserva color y orden.
 */
export function mergeGoogleEvents(data: CalendarData, incoming: CalendarEvent[], from: string, toExclusive: string): MergeResult {
  const byId = new Map<string, CalendarEvent>();
  for (const e of incoming) byId.set(e.id, e);
  let added = 0;
  let updated = 0;
  let removed = 0;
  const seen = new Set<string>();
  const events: CalendarEvent[] = [];
  for (const e of data.events) {
    const g = byId.get(e.id);
    if (g) {
      if (seen.has(e.id)) continue; // duplicado antiguo: se queda uno
      seen.add(e.id);
      const merged = { ...g, ...(e.color && { color: e.color }) };
      if (!same(e, merged)) updated++;
      events.push(same(e, merged) ? e : merged);
    } else if (e.id.startsWith(ID_PREFIX) && e.start.slice(0, 10) >= from && e.start.slice(0, 10) < toExclusive) {
      removed++;
    } else events.push(e);
  }
  for (const g of byId.values()) {
    if (seen.has(g.id)) continue;
    events.push(g);
    added++;
  }
  return { data: { ...data, events }, added, updated, removed };
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

/** Panel destino: el guardado, o el primer calendario titulado «Calendario», o uno nuevo. */
export function targetPanel(c: Connection, actor: Actor) {
  const saved = c.statusPanelId ? getPanel(c.statusPanelId) : null;
  if (saved && !saved.archived && saved.type === "calendario") return saved;
  if (saved?.archived) return null;
  const found = listPanels().find((p) => p.type === "calendario" && p.title.trim().toLowerCase() === "calendario");
  const panel = found ?? createPanel({ type: "calendario", title: "Calendario", actor });
  updateConnection(c.id, { statusPanelId: panel.id });
  return panel;
}

export interface DumpResult extends Omit<MergeResult, "data"> {
  panelId: string;
  panelTitle: string;
  total: number;
  from: string;
  to: string;
}

/** Vuelca los eventos de [from, toExclusive) al panel destino. */
export async function dumpToPanel(c: Connection, from: string, toExclusive: string, actor: Actor): Promise<DumpResult> {
  const panel = targetPanel(c, actor);
  if (!panel) throw new Error("El panel de destino está en la papelera. Recupéralo o pulsa «Volcar ahora» en Conexiones para usar otro.");
  const items = await fetchEvents(c, from, toExclusive);
  const incoming = items.map((x) => toPanelEvent(x.event)).filter((e): e is CalendarEvent => Boolean(e));
  const current = getPanel(panel.id)!;
  const r = mergeGoogleEvents(current.data as CalendarData, incoming, from, toExclusive);
  if (r.added || r.updated || r.removed) replacePanelData(panel.id, r.data, actor);
  return { panelId: panel.id, panelTitle: panel.title, total: incoming.length, added: r.added, updated: r.updated, removed: r.removed, from, to: addDays(toExclusive, -1) };
}

export function defaultWindow(at = new Date()) {
  const today = todayIn(TIMEZONE, at);
  return { from: addDays(today, -WINDOW_PAST_DAYS), toExclusive: addDays(today, WINDOW_FUTURE_DAYS + 1) };
}

export const dumpSummary = (r: DumpResult) =>
  `${r.total} evento(s) del ${r.from} al ${r.to} → panel «${r.panelTitle}»: ${r.added} nuevo(s), ${r.updated} actualizado(s), ${r.removed} quitado(s).`;

/**
 * Lo llama el worker cada 30 min (sin modelo). `false` = no tocaba (sin
 * autorizar o volcado desactivado). Si el panel está en la papelera, se
 * desactiva el volcado, como el panel de GitHub.
 */
export async function syncGoogleCalendar(c: Connection, at = new Date()): Promise<void | false> {
  if (c.config.panel === false || !readGoogleSecret(c.id)?.refreshToken) return false;
  const saved = c.statusPanelId ? getPanel(c.statusPanelId) : null;
  if (saved?.archived) {
    updateConnection(c.id, { config: { ...c.config, panel: false } });
    logActivity("sistema", `El panel «${saved.title}» está en la papelera: Google Calendar deja de volcarse (actívalo de nuevo en Conexiones).`);
    return false;
  }
  try {
    const { from, toExclusive } = defaultWindow(at);
    const r = await dumpToPanel(c, from, toExclusive, SYSTEM_ACTOR);
    if (r.added || r.updated || r.removed) logActivity("conexion", `Google Calendar volcado: ${dumpSummary(r)}`, null, { connectionId: c.id, panelId: r.panelId });
    markSync(c.id, null, at);
  } catch (err) {
    const msg = redact((err as Error).message);
    if (msg !== c.lastError) logActivity("error", `Conexión «${c.name}»: ${msg}`);
    markSync(c.id, msg, at);
    throw new Error(msg);
  }
}
