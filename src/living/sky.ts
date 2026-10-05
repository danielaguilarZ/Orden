/**
 * Cielo del living según la hora local: amanecer, día, atardecer y noche.
 *
 * Lógica pura (sin DOM) para poder probarla: dada una fecha devuelve la fase,
 * su intensidad (0 en los bordes de la fase, 1 en su punto álgido) y los
 * colores ya interpolados del fondo, el astro y las estrellas.
 */

export type SkyPhase = "amanecer" | "dia" | "atardecer" | "noche";

export const PHASE_LABEL: Record<SkyPhase, string> = {
  amanecer: "Amanecer",
  dia: "Día",
  atardecer: "Atardecer",
  noche: "Noche",
};

/** Inicio de cada fase en minutos desde medianoche (la noche cruza las 00:00). */
export const PHASE_START: Record<SkyPhase, number> = {
  amanecer: 6 * 60,
  dia: 9 * 60,
  atardecer: 18 * 60,
  noche: 21 * 60,
};

const DAY = 24 * 60;

/** Colores clave del cielo (arriba / horizonte); entre uno y otro se interpola. */
const KEYFRAMES: { at: number; top: string; bottom: string }[] = [
  { at: 0, top: "#070814", bottom: "#141a33" },
  { at: 5 * 60 + 30, top: "#0f1430", bottom: "#2a2a52" },
  { at: 6 * 60 + 30, top: "#2d3a6e", bottom: "#c96f6a" },
  { at: 7 * 60 + 30, top: "#5a7bbf", bottom: "#f2a968" },
  { at: 9 * 60, top: "#6fa6e0", bottom: "#cfe4f2" },
  { at: 13 * 60 + 30, top: "#4f9be6", bottom: "#bfe2fb" },
  { at: 18 * 60, top: "#5f93d0", bottom: "#e9d3a8" },
  { at: 19 * 60 + 30, top: "#4a4f8f", bottom: "#f08a4b" },
  { at: 21 * 60, top: "#1a1d45", bottom: "#4a3060" },
  { at: 22 * 60 + 30, top: "#0b0d1f", bottom: "#1b2040" },
  { at: DAY, top: "#070814", bottom: "#141a33" },
];

const GLOW: Record<SkyPhase, string> = {
  amanecer: "#ffb36b",
  dia: "#fff3c4",
  atardecer: "#ff8a4c",
  noche: "#dfe6ff",
};

export interface Sky {
  phase: SkyPhase;
  label: string;
  /** 0 en los bordes de la fase, 1 en su punto álgido (mediodía, plena noche…). */
  intensity: number;
  /** Avance dentro de la fase (0 → 1). */
  progress: number;
  top: string;
  bottom: string;
  /** Sol o luna: color, posición en % de la pantalla y opacidad. */
  glow: string;
  glowX: number;
  glowY: number;
  glowAlpha: number;
  /** Opacidad de las estrellas (0 de día). */
  stars: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mezcla dos colores #rrggbb (t = 0 → a, t = 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp01(t);
  return `#${ca.map((v, i) => Math.round(v + (cb[i] - v) * k).toString(16).padStart(2, "0")).join("")}`;
}

/** Minutos desde medianoche (0–1439) en la hora local de la fecha. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function phaseAt(minutes: number): SkyPhase {
  const m = ((minutes % DAY) + DAY) % DAY;
  if (m >= PHASE_START.amanecer && m < PHASE_START.dia) return "amanecer";
  if (m >= PHASE_START.dia && m < PHASE_START.atardecer) return "dia";
  if (m >= PHASE_START.atardecer && m < PHASE_START.noche) return "atardecer";
  return "noche";
}

/** Avance dentro de la fase actual (0 al empezar, 1 al terminar). */
export function phaseProgress(minutes: number): number {
  const m = ((minutes % DAY) + DAY) % DAY;
  const phase = phaseAt(m);
  const start = PHASE_START[phase];
  const end = phase === "noche" ? PHASE_START.amanecer + DAY : phase === "amanecer" ? PHASE_START.dia : phase === "dia" ? PHASE_START.atardecer : PHASE_START.noche;
  const pos = phase === "noche" && m < start ? m + DAY : m;
  return clamp01((pos - start) / (end - start));
}

function skyColors(m: number): { top: string; bottom: string } {
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const a = KEYFRAMES[i];
    const b = KEYFRAMES[i + 1];
    if (m >= a.at && m <= b.at) {
      const t = (m - a.at) / (b.at - a.at);
      return { top: mixHex(a.top, b.top, t), bottom: mixHex(a.bottom, b.bottom, t) };
    }
  }
  return { top: KEYFRAMES[0].top, bottom: KEYFRAMES[0].bottom };
}

export function skyAt(date: Date): Sky {
  const m = minutesOfDay(date);
  const phase = phaseAt(m);
  const progress = phaseProgress(m);
  const intensity = Math.sin(Math.PI * progress);
  const { top, bottom } = skyColors(m);

  // El sol recorre el cielo de 06:00 a 21:00; la luna, de 21:00 a 06:00.
  const isSun = phase !== "noche";
  const arc = isSun
    ? clamp01((m - PHASE_START.amanecer) / (PHASE_START.noche - PHASE_START.amanecer))
    : progress;
  const glowX = 10 + 80 * arc;
  const glowY = 80 - 65 * Math.sin(Math.PI * arc);
  const glowAlpha =
    phase === "dia" ? 0.35 + 0.3 * intensity : phase === "noche" ? 0.15 + 0.2 * intensity : 0.3 + 0.45 * intensity;

  const stars =
    phase === "noche" ? 0.35 + 0.65 * intensity : phase === "amanecer" ? 0.35 * (1 - progress) : phase === "atardecer" ? 0.35 * progress : 0;

  return {
    phase,
    label: PHASE_LABEL[phase],
    intensity: round(intensity),
    progress: round(progress),
    top,
    bottom,
    glow: GLOW[phase],
    glowX: round(glowX, 1),
    glowY: round(glowY, 1),
    glowAlpha: round(glowAlpha),
    stars: round(stars),
  };
}

/** Variables CSS para pintar el cielo en el contenedor del living. */
export function skyCssVars(sky: Sky): Record<string, string> {
  return {
    "--sky-top": sky.top,
    "--sky-bottom": sky.bottom,
    "--sky-glow": sky.glow,
    "--sky-glow-x": `${sky.glowX}%`,
    "--sky-glow-y": `${sky.glowY}%`,
    "--sky-glow-alpha": String(sky.glowAlpha),
    "--sky-stars": String(sky.stars),
  };
}
