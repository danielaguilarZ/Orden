import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import { fetchJson } from "./http";
import { auditor, guard, listField, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";
import { isDay } from "./google/time";

/**
 * Tipos de cambio oficiales del Banco Central Europeo (vía Frankfurter):
 * gratis, sin cuenta ni claves. Solo lectura. Se actualizan una vez al día
 * laborable (~16:00 CET).
 */

const API = "https://api.frankfurter.dev/v1";
const CODE = /^[A-Z]{3}$/;

interface Rates {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

export async function rates(base: string, to: string[], amount = 1, date?: string): Promise<Rates> {
  const b = base.toUpperCase();
  const t = to.map((x) => x.toUpperCase()).filter((x) => x !== b);
  if (!CODE.test(b) || t.some((x) => !CODE.test(x))) throw new Error("Usa códigos de divisa de 3 letras (EUR, USD, GBP…).");
  if (date && !isDay(date)) throw new Error("Fecha no válida (AAAA-MM-DD).");
  const q = new URLSearchParams({ base: b, amount: String(amount) });
  if (t.length) q.set("symbols", t.join(","));
  return fetchJson<Rates>(`${API}/${date ?? "latest"}?${q}`);
}

export function ratesText(r: Rates): string {
  const lines = Object.entries(r.rates).map(([k, v]) => `- ${r.amount.toLocaleString("es-ES")} ${r.base} = ${v.toLocaleString("es-ES", { maximumFractionDigits: 4 })} ${k}`);
  return [`Cambio oficial del BCE del ${r.date}:`, ...lines].join("\n");
}

function fxTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const c = grants[0].connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Divisas");
  return [
    defineTool(
      "divisas_cambio",
      `Tipo de cambio oficial del BCE (hoy o de una fecha) y conversión de importes. Por defecto ${String(c.config.base)} → ${(c.config.destino as string[]).join(", ")}.`,
      {
        de: z.string().length(3).optional(),
        a: z.array(z.string().length(3)).max(30).optional(),
        cantidad: z.number().positive().max(1e12).optional(),
        fecha: z.string().optional().describe("AAAA-MM-DD (por defecto, el último día publicado)"),
      },
      async ({ de, a, cantidad, fecha }) =>
        run(async () => {
          audit("consulta el cambio");
          return ratesText(await rates(de ?? String(c.config.base), a?.length ? a : (c.config.destino as string[]), cantidad ?? 1, fecha));
        }),
    ),
  ];
}

registerService({
  key: "divisas",
  label: "Divisas (BCE)",
  description: "Tipos de cambio oficiales del Banco Central Europeo y conversión de importes, también de fechas pasadas. Gratis y sin claves.",
  category: "finanzas",
  readOnly: true,
  levels: { lectura: "Lectura: consultar tipos de cambio y convertir", completo: "Completo: igual que lectura" },
  fields: [
    { key: "base", label: "Divisa base", placeholder: "EUR" },
    { key: "destino", label: "Divisas que sigues", placeholder: "USD, GBP, CHF" },
  ],
  supportsSecret: false,
  steps: ["Elige tu divisa base (EUR por defecto) y las que sigues; pulsa «Añadir».", "Pulsa «Probar conexión» para ver el cambio de hoy.", "Da lectura a quien lleve tus finanzas o viajes."],
  normalizeConfig(input) {
    const base = String(input.base ?? "").trim().toUpperCase() || "EUR";
    const destino = listField(input.destino, 30).map((x) => x.toUpperCase());
    if (!CODE.test(base) || destino.some((x) => !CODE.test(x))) throw new Error("Usa códigos de divisa de 3 letras (EUR, USD, GBP…).");
    return { base, destino: destino.length ? destino : ["USD", "GBP"] };
  },
  defaultName(config) {
    return `Divisas · ${String(config.base)}`;
  },
  tools: fxTools,
  prompt() {
    return "Divisas (cambio oficial del BCE): divisas_cambio para tipos de cambio y conversiones, también de fechas pasadas.";
  },
  test(c) {
    return testWith(c, async () => ratesText(await rates(String(c.config.base), c.config.destino as string[])));
  },
});
