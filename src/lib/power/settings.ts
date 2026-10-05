import { z } from "zod";
import { emit } from "../events";
import { getSetting, setSetting } from "../repo/system";

/**
 * Ajustes de energía (tabla `settings`, clave «power»). La web los cambia y el
 * worker los lee en cada vuelta del planificador (sin reiniciar nada).
 */
export const powerSettingsSchema = z.object({
  /** Mantener el PC despierto mientras Orden esté en marcha (no impide apagar la pantalla). */
  keepAwake: z.boolean(),
  /** Programar un temporizador de Windows que despierte el PC para la próxima rutina. */
  wakeForRoutines: z.boolean(),
});

export type PowerSettings = z.infer<typeof powerSettingsSchema>;

export const POWER_KEY = "power";
export const DEFAULT_POWER: PowerSettings = { keepAwake: false, wakeForRoutines: false };

export function getPowerSettings(): PowerSettings {
  return { ...DEFAULT_POWER, ...getSetting<Partial<PowerSettings>>(POWER_KEY, {}) };
}

export function setPowerSettings(patch: Partial<PowerSettings>): PowerSettings {
  const next = powerSettingsSchema.parse({ ...getPowerSettings(), ...patch });
  setSetting(POWER_KEY, next);
  emit("power.updated", next);
  return next;
}

/** Estado que publica el worker en su latido (`info.power`) para la interfaz. */
export interface PowerStatus {
  /** Solo Windows sabe mantener el PC despierto y programar el despertar. */
  supported: boolean;
  /** El PC no se suspende por inactividad ahora mismo (petición ES_SYSTEM_REQUIRED activa). */
  awake: boolean;
  /** Motivo: «siempre» (ajuste) o «trabajando» (hay encargos en marcha). */
  awakeReason: "siempre" | "trabajando" | null;
  awakeError: string | null;
  /** Hora (ISO) a la que está programado el despertar, si lo hay. */
  wakeAt: string | null;
  wakeError: string | null;
  /** Última vuelta de la suspensión detectada por el worker. */
  lastResume: { at: string; gapMs: number } | null;
}
