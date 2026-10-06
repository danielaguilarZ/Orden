import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson } from "./http";
import { auditor, guard, listField, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Cotizaciones de bolsa (acciones, índices, fondos cotizados, ETF) con los
 * datos públicos de Yahoo Finance. Solo lectura y sin claves. No es una API
 * oficial: si cambia, la conexión avisará con un error.
 */

const API = "https://query1.finance.yahoo.com";
const HEADERS = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Orden)" };
const SYMBOL = /^[A-Za-z0-9^=.\-]{1,20}$/;

interface Meta {
  symbol: string;
  currency?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;
  exchangeName?: string;
  longName?: string;
  shortName?: string;
}

export async function quote(symbol: string): Promise<Meta> {
  if (!SYMBOL.test(symbol)) throw new Error(`Símbolo no válido: «${symbol}».`);
  const r = await fetchJson<{ chart: { result?: { meta: Meta }[] | null; error?: { description?: string } | null } }>(
    `${API}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
    { headers: HEADERS },
  );
  const meta = r.chart.result?.[0]?.meta;
  if (!meta) throw new Error(`Sin datos para «${symbol}»${r.chart.error?.description ? `: ${r.chart.error.description}` : ""}.`);
  return meta;
}

export function quoteLine(m: Meta): string {
  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose;
  const ch = price !== undefined && prev ? ((price - prev) / prev) * 100 : null;
  const when = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  const name = m.longName ?? m.shortName;
  return `- ${m.symbol}${name ? ` (${name})` : ""}: ${price?.toLocaleString("es-ES", { maximumFractionDigits: 4 }) ?? "?"} ${m.currency ?? ""}${ch !== null ? ` · ${ch >= 0 ? "+" : ""}${ch.toFixed(2)} % vs. cierre anterior` : ""}${when ? ` · ${when}` : ""}`;
}

export async function quotesText(symbols: string[]): Promise<string> {
  const res = await Promise.allSettled(symbols.map((s) => quote(s.trim())));
  const lines = res.map((r, i) => (r.status === "fulfilled" ? quoteLine(r.value) : `- ${symbols[i]}: ${(r.reason as Error).message}`));
  if (res.every((r) => r.status === "rejected")) throw new Error(lines.join("\n"));
  return ["Cotizaciones (Yahoo Finance, pueden ir con retraso):", ...lines].join("\n");
}

export async function searchSymbols(text: string): Promise<string> {
  const q = new URLSearchParams({ q: text, quotesCount: "8", newsCount: "0" });
  const r = await fetchJson<{ quotes?: { symbol: string; shortname?: string; longname?: string; exchDisp?: string; quoteType?: string }[] }>(`${API}/v1/finance/search?${q}`, { headers: HEADERS });
  const list = r.quotes ?? [];
  return list.length ? list.map((x) => `- ${x.symbol} · ${x.longname ?? x.shortname ?? "?"}${x.exchDisp ? ` · ${x.exchDisp}` : ""}${x.quoteType ? ` · ${x.quoteType}` : ""}`).join("\n") : `Nada con «${text}».`;
}

function stockTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const c = grants[0].connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Bolsa");
  const defaults = (c.config.simbolos as string[]) ?? [];
  return [
    defineTool(
      "bolsa_cotizacion",
      `Cotización actual y variación de acciones, índices o ETF (símbolos de Yahoo: SAN.MC, ^IBEX, AAPL, VWCE.DE…). Por defecto: ${defaults.join(", ")}.`,
      { simbolos: z.array(z.string().max(20)).max(20).optional() },
      async ({ simbolos }) =>
        run(async () => {
          const list = simbolos?.length ? simbolos : defaults;
          audit(`consulta ${list.join(", ")}`);
          return quotesText(list);
        }),
    ),
    defineTool("bolsa_buscar", "Busca el símbolo de una empresa, índice o fondo en Yahoo Finance.", { texto: z.string().min(1).max(60) }, async ({ texto }) =>
      run(async () => {
        audit(`busca «${texto}»`);
        return searchSymbols(texto);
      }),
    ),
  ];
}

registerService({
  key: "bolsa",
  label: "Bolsa (Yahoo Finance)",
  description: "Cotizaciones de acciones, índices y ETF (IBEX, S&P 500, tus fondos…). Gratis y sin cuenta; datos con posible retraso.",
  category: "finanzas",
  readOnly: true,
  levels: { lectura: "Lectura: consultar cotizaciones y buscar símbolos", completo: "Completo: igual que lectura" },
  fields: [{ key: "simbolos", label: "Símbolos por defecto", placeholder: "^IBEX, SAN.MC, VWCE.DE" }],
  supportsSecret: false,
  steps: [
    "Escribe los símbolos que sigues tal y como salen en finance.yahoo.com (p. ej. ^IBEX, SAN.MC, AAPL) y pulsa «Añadir».",
    "Pulsa «Probar conexión» para ver sus cotizaciones.",
    "Da lectura a quien lleve tus finanzas (p. ej. Fina). Ojo: es una fuente no oficial y puede ir con retraso.",
  ],
  normalizeConfig(input) {
    const simbolos = listField(input.simbolos, 20).map((s) => s.toUpperCase());
    for (const s of simbolos) if (!SYMBOL.test(s)) throw new Error(`Símbolo no válido: «${s}».`);
    return { simbolos: simbolos.length ? simbolos : ["^IBEX"] };
  },
  defaultName(config) {
    const s = config.simbolos as string[];
    return s.length === 1 ? `Bolsa · ${s[0]}` : `Bolsa · ${s.length} valores`;
  },
  tools: stockTools,
  prompt() {
    return "Bolsa (Yahoo Finance, datos públicos con posible retraso): bolsa_cotizacion y bolsa_buscar. Cita la hora de los datos y no des consejos de inversión.";
  },
  test(c) {
    return testWith(c, async () => quotesText(c.config.simbolos as string[]));
  },
});
