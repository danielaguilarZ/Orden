import { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../agents/tools";
import { logActivity } from "../repo/system";
import { fetchJson } from "./http";
import { registerService, type AgentGrant } from "./registry";

/**
 * Tiempo (clima) con Open-Meteo: datos públicos, sin cuenta ni clave y sin
 * nada que guardar cifrado. Solo lectura.
 */

const WMO: Record<number, string> = {
  0: "despejado",
  1: "casi despejado",
  2: "parcialmente nuboso",
  3: "nublado",
  45: "niebla",
  48: "niebla con escarcha",
  51: "llovizna débil",
  53: "llovizna",
  55: "llovizna intensa",
  56: "llovizna helada",
  57: "llovizna helada intensa",
  61: "lluvia débil",
  63: "lluvia",
  65: "lluvia intensa",
  66: "lluvia helada",
  67: "lluvia helada intensa",
  71: "nieve débil",
  73: "nieve",
  75: "nieve intensa",
  77: "granos de nieve",
  80: "chubascos débiles",
  81: "chubascos",
  82: "chubascos fuertes",
  85: "chubascos de nieve",
  86: "chubascos de nieve fuertes",
  95: "tormenta",
  96: "tormenta con granizo",
  99: "tormenta con granizo fuerte",
};

/** Código meteorológico WMO → texto. */
export function weatherText(code: number): string {
  return WMO[code] ?? `código ${code}`;
}

export interface Place {
  name: string;
  latitude: number;
  longitude: number;
}

const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Ciudad (se busca en el geocodificador de Open-Meteo) o «lat,lon». */
export async function resolvePlace(lugar: string): Promise<Place> {
  const m = COORDS.exec(lugar);
  if (m) {
    const latitude = Number(m[1]);
    const longitude = Number(m[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error("Coordenadas fuera de rango.");
    return { name: lugar.trim(), latitude, longitude };
  }
  const q = new URLSearchParams({ name: lugar.trim(), count: "1", language: "es", format: "json" });
  const r = await fetchJson<{ results?: { name: string; latitude: number; longitude: number; admin1?: string; country?: string }[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?${q}`,
  );
  const p = r.results?.[0];
  if (!p) throw new Error(`No encuentro «${lugar}». Prueba con otra forma del nombre o con «lat,lon».`);
  return { name: [p.name, p.admin1, p.country].filter(Boolean).join(", "), latitude: p.latitude, longitude: p.longitude };
}

interface Forecast {
  current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max?: (number | null)[];
  };
}

/** Previsión legible: ahora y los próximos `days` días (1-7). */
export async function forecastText(lugar: string, days: number): Promise<string> {
  const place = await resolvePlace(lugar);
  const q = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: String(Math.min(7, Math.max(1, Math.round(days)))),
  });
  const f = await fetchJson<Forecast>(`https://api.open-meteo.com/v1/forecast?${q}`);
  const lines = [`Tiempo en ${place.name}:`];
  if (f.current) {
    lines.push(`- Ahora: ${Math.round(f.current.temperature_2m)} °C, ${weatherText(f.current.weather_code)}, viento ${Math.round(f.current.wind_speed_10m)} km/h.`);
  }
  const d = f.daily;
  if (d) {
    d.time.forEach((day, i) => {
      const rain = d.precipitation_probability_max?.[i];
      lines.push(
        `- ${day}: ${weatherText(d.weather_code[i])}, ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])} °C${rain != null ? `, lluvia ${rain} %` : ""}.`,
      );
    });
  }
  return lines.join("\n");
}

function weatherTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const c = grants[0].connection;
  return [
    defineTool(
      "clima_prevision",
      `Tiempo actual y previsión (1-7 días) de ${String(c.config.lugar)} o de otro lugar. Datos públicos de Open-Meteo.`,
      {
        dias: z.number().int().min(1).max(7).optional().describe("Días de previsión (por defecto 3)"),
        lugar: z.string().max(80).optional().describe(`Por defecto, ${String(c.config.lugar)}`),
      },
      async ({ dias, lugar }) => {
        try {
          const where = lugar?.trim() || String(c.config.lugar);
          const text = await forecastText(where, dias ?? 3);
          logActivity("conexion", `${ctx.agent.name} consulta el tiempo de ${where}`, ctx.agent.id, { connectionId: c.id, taskId: ctx.task.id });
          return ok(text);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
  ];
}

registerService({
  key: "clima",
  label: "Tiempo (clima)",
  description: "Previsión del tiempo de Open-Meteo para tu ciudad. Gratis, sin cuenta ni clave.",
  levels: { lectura: "Lectura: consultar el tiempo y la previsión (hasta 7 días)", completo: "Completo: igual que lectura (no hay nada que escribir)" },
  fields: [{ key: "lugar", label: "Ciudad o «lat,lon»", placeholder: "Madrid" }],
  supportsSecret: false,
  readOnly: true,
  steps: [
    "Escribe tu ciudad (o sus coordenadas «lat,lon») y pulsa «Añadir».",
    "Pulsa «Probar conexión»: verás el tiempo de hoy.",
    "Da permiso de lectura a los agentes que lo necesiten (p. ej. Zen, para el resumen de la mañana).",
  ],
  normalizeConfig(input) {
    const lugar = String(input.lugar ?? "").trim();
    if (!lugar) throw new Error("Escribe una ciudad o unas coordenadas «lat,lon».");
    if (lugar.length > 80) throw new Error("Nombre de lugar demasiado largo.");
    return { lugar };
  },
  defaultName(config) {
    return `Tiempo · ${String(config.lugar)}`;
  },
  tools: weatherTools,
  prompt(grants) {
    return `Tiempo (Open-Meteo): consulta el tiempo y la previsión con clima_prevision (por defecto ${grants.map((g) => String(g.connection.config.lugar)).join(", ")}). Datos públicos, sin coste.`;
  },
  async test(c) {
    try {
      return { ok: true, text: await forecastText(String(c.config.lugar), 1) };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  },
});
