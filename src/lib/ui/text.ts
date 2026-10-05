/**
 * Utilidades de presentación comunes a todas las pestañas: resúmenes de una
 * línea, fechas relativas y agrupación por día. Lógica pura (sin React ni
 * servidor) para poder probarla.
 */

/** Normaliza para buscar sin tildes ni mayúsculas. */
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** ¿Contiene `text` todas las palabras de `query` (sin tildes ni mayúsculas)? */
export function matches(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(text);
  return words.every((w) => hay.includes(w));
}

/** Quita la sintaxis markdown más común de una línea. */
function plain(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`|~~)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Líneas con contenido, ya sin markdown. */
const lines = (text: string) => text.split(/\r?\n/).map(plain).filter(Boolean);

/** Recorta a `max` caracteres sin partir palabras y con «…». */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.·—-]+$/, "")}…`;
}

/** Resumen de una línea: la primera línea con texto, sin markdown y recortada. */
export function summarize(text: string, max = 120): string {
  const first = lines(text)[0] ?? "";
  return truncate(first, max);
}

/** ¿El texto completo dice bastante más que su resumen? (merece «ver más»). */
export function hasMore(text: string, max = 120): boolean {
  const ls = lines(text);
  return ls.length > 1 || (ls[0]?.length ?? 0) > max;
}

/** «1 recuerdo» / «3 recuerdos». */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Días naturales (hora local) entre `iso` y `now`: 0 = hoy, 1 = ayer, -1 = mañana. */
export function daysAgo(iso: string, now = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
}

/** «hoy», «ayer», «hace 3 días», «5 oct» o «5 oct 2025». */
export function relativeDate(iso: string, now = new Date()): string {
  const n = daysAgo(iso, now);
  if (n === 0) return "hoy";
  if (n === 1) return "ayer";
  if (n === -1) return "mañana";
  if (n > 1 && n < 7) return `hace ${n} días`;
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** Hora local «08:30». */
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

/** «hoy 08:30», «mañana 09:00», «jue 8 oct 10:00» (para lo que está por venir). */
export function whenLabel(iso: string, now = new Date()): string {
  const n = daysAgo(iso, now);
  if (n === 0) return `hoy ${timeOf(iso)}`;
  if (n === -1) return `mañana ${timeOf(iso)}`;
  if (n === 1) return `ayer ${timeOf(iso)}`;
  return new Date(iso).toLocaleString("es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Cabecera de un día: «Hoy», «Ayer» o «Sábado, 3 oct». */
export function dayLabel(iso: string, now = new Date()): string {
  const n = daysAgo(iso, now);
  if (n === 0) return "Hoy";
  if (n === 1) return "Ayer";
  const d = new Date(iso);
  const s = d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Clave del día local (AAAA-MM-DD) de una fecha ISO. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Agrupa por día local manteniendo el orden de entrada. */
export function groupByDay<T>(items: T[], dateOf: (it: T) => string): { day: string; first: string; items: T[] }[] {
  const out: { day: string; first: string; items: T[] }[] = [];
  for (const it of items) {
    const iso = dateOf(it);
    const day = dayKey(iso);
    const last = out.at(-1);
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, first: iso, items: [it] });
  }
  return out;
}
