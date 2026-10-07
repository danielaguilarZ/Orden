import type { ClaudeUsage, UsageWindow } from "../claude/usageText";
import { getSetting, setSetting } from "../repo/system";
import { emit } from "../events";

/**
 * Regulador del piloto automático: decide si el equipo puede trabajar por su
 * cuenta según los límites del plan de Claude. Los encargos del usuario no
 * pasan por aquí: siempre se atienden.
 *
 * - Semana: no pasa de `weeklyMax` y lo reparte por días (puede adelantar un
 *   día), para no quemar la semana el lunes.
 * - Sesión de 5 h: se para en `sessionMax`, para dejar margen al usuario.
 * - Sin medidor fiable (modo API key o datos viejos) no trabaja: nunca gasta a ciegas.
 */

export interface AutopilotSettings {
  enabled: boolean;
  /** % de la semana que puede usar el trabajo autónomo. */
  weeklyMax: number;
  /** % de la sesión de 5 h a partir del cual se para. */
  sessionMax: number;
  /** Encargos autónomos a la vez (siempre queda un hueco para el usuario). */
  maxParallel: number;
}

export const DEFAULT_AUTOPILOT: AutopilotSettings = { enabled: false, weeklyMax: 70, sessionMax: 80, maxParallel: 2 };

const SETTING = "autopilot";

export function getAutopilotSettings(): AutopilotSettings {
  return { ...DEFAULT_AUTOPILOT, ...getSetting<Partial<AutopilotSettings>>(SETTING, {}) };
}

export function setAutopilotSettings(patch: Partial<AutopilotSettings>): AutopilotSettings {
  const next = { ...getAutopilotSettings(), ...patch };
  setSetting(SETTING, next);
  emit("autopilot.updated", next);
  return next;
}

export interface BudgetVerdict {
  allowed: boolean;
  /** Por qué no (o «Con margen»), para mostrarlo en la interfaz. */
  reason: string;
  /** Opus tiene su propio límite semanal: si está cerca, las tareas van con Sonnet. */
  allowOpus: boolean;
  /** % semanal que se permite haber gastado a estas alturas de la semana. */
  weeklyAllowance: number | null;
}

const WEEK_MS = 7 * 24 * 3600_000;
const STALE_MS = 20 * 60_000;

/** % de la semana que se puede haber gastado ya, repartido por días (con un día de adelanto). */
export function weeklyAllowance(week: UsageWindow, weeklyMax: number, at: Date): number {
  if (!week.resetsAt) return weeklyMax;
  const start = Date.parse(week.resetsAt) - WEEK_MS;
  const elapsed = Math.min(1, Math.max(0, (at.getTime() - start) / WEEK_MS));
  return Math.round(weeklyMax * Math.min(1, elapsed + 1 / 7));
}

export function judgeBudget(usage: ClaudeUsage | null, s: AutopilotSettings, at = new Date()): BudgetVerdict {
  const no = (reason: string): BudgetVerdict => ({ allowed: false, reason, allowOpus: false, weeklyAllowance: null });
  if (!s.enabled) return no("Piloto automático apagado.");
  if (!usage?.available) return no("Sin medidor de límites de Claude: el piloto automático no gasta a ciegas.");
  if (at.getTime() - Date.parse(usage.fetchedAt) > STALE_MS) return no("Los límites de Claude no se han leído hace rato: espero a tener datos frescos.");
  const win = (key: string) => usage.windows.find((w) => w.key === key);
  const session = win("five_hour");
  const week = win("seven_day");
  if (session && session.percent >= s.sessionMax) return no(`Sesión de 5 h al ${session.percent} % (tope ${s.sessionMax} %): margen para ti.`);
  if (week) {
    if (week.percent >= s.weeklyMax) return no(`Semana al ${week.percent} % (tope ${s.weeklyMax} %).`);
    const allowance = weeklyAllowance(week, s.weeklyMax, at);
    if (week.percent >= allowance) return { ...no(`Semana al ${week.percent} %: hoy toca hasta el ${allowance} % para repartirla.`), weeklyAllowance: allowance };
    const opus = win("seven_day_opus");
    return { allowed: true, reason: "Con margen.", allowOpus: !opus || opus.percent < s.weeklyMax, weeklyAllowance: allowance };
  }
  return { allowed: true, reason: "Con margen.", allowOpus: true, weeklyAllowance: null };
}
