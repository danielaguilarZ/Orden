import { z } from "zod";
import { TIMEZONE } from "../../agents/prompt";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../../agents/tools";
import { logActivity } from "../../repo/system";
import { redact } from "../../secrets";
import type { AgentGrant } from "../registry";
import { CalendarReader, type GEvent } from "./api";
import { calendarsOf, fetchEvents, plainText } from "./sync";
import { addDays, daysBetween, isDay } from "./time";

/**
 * Herramientas de Google Calendar (solo lectura) para quien tenga permiso.
 * Ninguna escribe en Google: leer eventos y ver calendarios. Cada uso queda
 * en Actividad.
 */

const MAX_RANGE_DAYS = 93;
const MAX_LIST = 300;

const fmtDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-ES", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

/** Una línea por evento, en hora local. */
export function eventLine(e: GEvent, calendar: string, showCalendar: boolean): string {
  const tf = (iso: string) => new Date(iso).toLocaleTimeString("es-ES", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
  const df = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: TIMEZONE });
  let when: string;
  if (e.start.date) {
    const last = e.end?.date ? addDays(e.end.date, -1) : e.start.date;
    when = `${fmtDay(e.start.date)}${last > e.start.date ? ` – ${fmtDay(last)}` : ""} · todo el día`;
  } else {
    const s = e.start.dateTime!;
    const end = e.end?.dateTime;
    when = `${fmtDay(df(s))} · ${tf(s)}${end ? `–${df(end) !== df(s) ? `${fmtDay(df(end))} ` : ""}${tf(end)}` : ""}`;
  }
  const notes = plainText(e.description, 200);
  return [
    `- ${when} · ${e.summary?.trim() || "(sin título)"}`,
    e.location ? ` · ${e.location}` : "",
    showCalendar ? ` [${calendar}]` : "",
    ` (id ${e.id})`,
    notes ? `\n  ${notes.replace(/\n+/g, " ")}` : "",
  ].join("");
}

export function googleCalendarTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  // Solo lectura: cualquier nivel concedido da lo mismo. Si hay varias conexiones, la primera.
  const g = grants[0];
  const c = g.connection;
  const cals = calendarsOf(c);

  const audit = (text: string, data: Record<string, unknown> = {}) => {
    ctx.note(`Google Calendar · ${text}`, { kind: "google_calendar" });
    logActivity("conexion", `${ctx.agent.name} en Google Calendar: ${text}`, ctx.agent.id, { connectionId: c.id, taskId: ctx.task.id, ...data });
  };
  const guard = async (fn: () => Promise<string>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(`Google Calendar: ${redact((err as Error).message)}`);
    }
  };
  const range = (desde: string, hasta: string | undefined, maxDays: number) => {
    const to = hasta ?? desde;
    if (!isDay(desde) || !isDay(to)) throw new Error("Las fechas van en formato AAAA-MM-DD.");
    const days = daysBetween(desde, to) + 1;
    if (days < 1) throw new Error("«hasta» no puede ser anterior a «desde».");
    if (days > maxDays) throw new Error(`Rango demasiado largo (${days} días; máximo ${maxDays}).`);
    return { from: desde, toExclusive: addDays(to, 1), days };
  };

  return [
    defineTool(
      "google_calendario_eventos",
      "Lista los eventos de Google Calendar (solo lectura) entre dos fechas, ambas incluidas, en hora local. Opcional: un calendario concreto y texto a buscar.",
      {
        desde: z.string().describe("Primer día, AAAA-MM-DD"),
        hasta: z.string().optional().describe(`Último día (incluido), AAAA-MM-DD; por defecto = desde. Máx. ${MAX_RANGE_DAYS} días`),
        ...(cals.length > 1 && { calendario: z.enum(cals as [string, ...string[]]).optional().describe("Solo este calendario; por defecto, todos los conectados") }),
        texto: z.string().max(200).optional().describe("Solo eventos que contengan este texto"),
      },
      (a: { desde: string; hasta?: string; calendario?: unknown; texto?: string }) =>
        guard(async () => {
          const r = range(a.desde, a.hasta, MAX_RANGE_DAYS);
          const only = a.calendario ? String(a.calendario) : undefined;
          if (only && !cals.includes(only)) throw new Error(`Ese calendario no está conectado. Conectados: ${cals.join(", ")}.`);
          const items = await fetchEvents(c, r.from, r.toExclusive, { calendars: only ? [only] : undefined, q: a.texto, max: MAX_LIST });
          const sortKey = (e: GEvent) => e.start.dateTime ? new Date(e.start.dateTime).toISOString() : `${e.start.date}T00:00`;
          items.sort((x, y) => sortKey(x.event).localeCompare(sortKey(y.event)));
          const to = addDays(r.toExclusive, -1);
          audit(`leídos ${items.length} evento(s) del ${r.from} al ${to}${a.texto ? ` (busca «${a.texto}»)` : ""}`, { from: r.from, to, count: items.length });
          if (!items.length) return `Sin eventos del ${r.from} al ${to}.`;
          const multi = (only ? 1 : cals.length) > 1;
          return `${items.length} evento(s) del ${r.from} al ${to} (hora ${TIMEZONE}):\n${items.slice(0, MAX_LIST).map((x) => eventLine(x.event, x.calendar, multi)).join("\n")}`;
        }),
    ),
    defineTool(
      "google_calendario_calendarios",
      "Lista los calendarios de la cuenta de Google y cuáles están conectados a Orden.",
      {},
      () =>
        guard(async () => {
          const list = await new CalendarReader(c.id).calendars();
          audit(`listados ${list.length} calendario(s)`);
          const on = new Set(cals);
          return list
            .map((x) => `- ${x.summary ?? x.id}${x.primary ? " (principal)" : ""} · id ${x.id}${on.has(x.id) || (x.primary && on.has("primary")) ? " · conectado" : ""}`)
            .join("\n") || "No hay calendarios.";
        }),
    ),
  ];
}
