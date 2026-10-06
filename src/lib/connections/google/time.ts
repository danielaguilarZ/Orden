/**
 * Fechas en la zona horaria del usuario (Europe/Madrid por defecto) sin
 * dependencias: los agentes hablan en hora local «flotante»
 * (AAAA-MM-DDTHH:MM) y Google trabaja con instantes RFC 3339.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

function parts(at: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour") % 24, mi: g("minute"), s: g("second") };
}

/** Desfase (ms) de la zona respecto a UTC en ese instante. */
export function tzOffsetMs(at: Date, tz: string): number {
  const p = parts(at, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** ¿Es una fecha AAAA-MM-DD real? */
export function isDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Hora local (AAAA-MM-DD o AAAA-MM-DDTHH:MM) → instante. */
export function localToDate(local: string, tz: string): Date {
  const m = local.match(LOCAL_RE);
  if (!m) throw new Error(`Fecha no válida: «${local}». Usa AAAA-MM-DD.`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const first = guess - tzOffsetMs(new Date(guess), tz);
  const second = guess - tzOffsetMs(new Date(first), tz);
  return new Date(second);
}

/** Instante → hora local AAAA-MM-DDTHH:MM. */
export function dateToLocal(at: Date, tz: string): string {
  const p = parts(at, tz);
  const n = (v: number, l = 2) => String(v).padStart(l, "0");
  return `${n(p.y, 4)}-${n(p.m)}-${n(p.d)}T${n(p.h)}:${n(p.mi)}`;
}

/** Hoy (AAAA-MM-DD) en la zona. */
export function todayIn(tz: string, at = new Date()): string {
  return dateToLocal(at, tz).slice(0, 10);
}

/** Suma días a una fecha AAAA-MM-DD. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días entre dos fechas AAAA-MM-DD (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
