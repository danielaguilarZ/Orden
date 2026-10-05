/** Tipos y textos de los límites de Claude (sin dependencias: se usan también en el navegador). */

export interface UsageWindow {
  key: string;
  label: string;
  /** 0-100 */
  percent: number;
  resetsAt: string | null;
}

export interface ClaudeUsage {
  available: boolean;
  plan: string | null;
  windows: UsageWindow[];
  fetchedAt: string;
  error?: string;
}

/** Texto corto: «23 % · se reinicia en 2 h 13 min». */
export function describeWindow(w: UsageWindow, now = new Date()): string {
  return `${Math.round(w.percent)} %${w.resetsAt ? ` · se reinicia ${untilText(w.resetsAt, now)}` : ""}`;
}

export function untilText(iso: string, now = new Date()): string {
  const ms = Date.parse(iso) - now.getTime();
  if (ms <= 0) return "ya";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `en ${h} h ${min % 60} min` : `en ${h} h`;
  const d = Math.floor(h / 24);
  return `en ${d} d ${h % 24} h`;
}
