import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import { TIMEZONE } from "../agents/prompt";
import { fetchJson } from "./http";
import { auditor, guard, testWith } from "./kit";
import { todayIn } from "./google/time";
import { registerService, type AgentGrant } from "./registry";

/**
 * Festivos oficiales nacionales y regionales (Nager.Date): gratis, sin claves.
 * Solo lectura. Los festivos locales de cada municipio no vienen.
 */

const API = "https://date.nager.at/api/v3";

export interface Holiday {
  date: string;
  localName: string;
  name: string;
  global: boolean;
  counties: string[] | null;
}

export async function holidays(country: string, region: string, year: number): Promise<Holiday[]> {
  const list = await fetchJson<Holiday[]>(`${API}/PublicHolidays/${year}/${country}`);
  return list.filter((h) => h.global || !region || (h.counties ?? []).includes(region));
}

export const holidayLine = (h: Holiday) => `- ${h.date} · ${h.localName}${h.global ? "" : " (regional)"}`;

export async function holidaysText(country: string, region: string, opts: { year?: number; from?: string; max?: number } = {}): Promise<string> {
  const today = todayIn(TIMEZONE);
  const from = opts.from ?? (opts.year ? `${opts.year}-01-01` : today);
  const y0 = Number(from.slice(0, 4));
  const years = opts.year ? [opts.year] : [y0, y0 + 1];
  const all = (await Promise.all(years.map((y) => holidays(country, region, y)))).flat().filter((h) => h.date >= from);
  const shown = all.slice(0, opts.max ?? (opts.year ? 50 : 10));
  if (!shown.length) return "No hay festivos en ese periodo.";
  return [`Festivos de ${country}${region ? ` (${region})` : ""}${opts.year ? ` en ${opts.year}` : " próximos"}:`, ...shown.map(holidayLine)].join("\n");
}

function holidayTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const c = grants[0].connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Festivos");
  return [
    defineTool(
      "festivos",
      `Festivos oficiales de ${String(c.config.pais)}${c.config.region ? ` (${String(c.config.region)})` : ""}: los próximos o los de un año. No incluye los locales del municipio.`,
      { anio: z.number().int().min(1975).max(2100).optional(), max: z.number().int().min(1).max(60).optional() },
      async ({ anio, max }) =>
        run(async () => {
          audit(`consulta festivos${anio ? ` de ${anio}` : ""}`);
          return holidaysText(String(c.config.pais), String(c.config.region ?? ""), { year: anio, max });
        }),
    ),
  ];
}

registerService({
  key: "festivos",
  label: "Festivos",
  description: "Festivos oficiales nacionales y de tu comunidad autónoma, para planificar la agenda. Gratis y sin claves.",
  category: "agenda",
  readOnly: true,
  levels: { lectura: "Lectura: consultar festivos", completo: "Completo: igual que lectura" },
  fields: [
    { key: "pais", label: "País (código)", placeholder: "ES" },
    { key: "region", label: "Región (opcional)", placeholder: "ES-MD (Madrid), ES-CT, ES-AN…" },
  ],
  supportsSecret: false,
  steps: [
    "Escribe el código de país (ES) y, si quieres los regionales, el de tu comunidad (ES-MD Madrid, ES-CT Cataluña, ES-AN Andalucía, ES-VC Valencia…). Pulsa «Añadir».",
    "Pulsa «Probar conexión» para ver los próximos festivos.",
    "Da lectura a quien lleve tu agenda. Los festivos locales de tu municipio no vienen: añádelos a mano en el calendario.",
  ],
  normalizeConfig(input) {
    const pais = String(input.pais ?? "").trim().toUpperCase() || "ES";
    const region = String(input.region ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(pais)) throw new Error("País no válido (código de 2 letras, p. ej. ES).");
    if (region && !new RegExp(`^${pais}-[A-Z0-9]{1,3}$`).test(region)) throw new Error(`Región no válida (p. ej. ${pais}-MD).`);
    return { pais, region };
  },
  defaultName(config) {
    return `Festivos · ${String(config.region || config.pais)}`;
  },
  tools: holidayTools,
  prompt() {
    return "Festivos oficiales: la herramienta festivos (próximos o de un año). No incluye los locales del municipio.";
  },
  test(c) {
    return testWith(c, async () => holidaysText(String(c.config.pais), String(c.config.region ?? ""), { max: 3 }));
  },
});
