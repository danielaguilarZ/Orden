import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import { getConnectionSecret, type Connection } from "../repo/connections";
import { fetchJson } from "./http";
import { auditor, guard, listField, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Cotizaciones de criptomonedas con CoinGecko (API pública). Solo lectura.
 * La clave «demo» es opcional (más margen de peticiones) y va cifrada.
 */

const API = "https://api.coingecko.com/api/v3";
const CURRENCY = /^[a-z]{3,5}$/;

const headers = (c: Connection): Record<string, string> => {
  const key = getConnectionSecret(c.id);
  return key ? { "x-cg-demo-api-key": key, Accept: "application/json" } : { Accept: "application/json" };
};

function get<T>(c: Connection, path: string): Promise<T> {
  return fetchJson<T>(`${API}${path}`, { headers: headers(c) }, { secrets: [getConnectionSecret(c.id)] });
}

interface Coin {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank?: number | null;
}

/** Ids de CoinGecko a partir de ids o símbolos («btc» → «bitcoin»). */
export async function resolveCoins(c: Connection, refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (/^[a-z0-9-]+$/.test(r) && r.length > 5) {
      out.push(r);
      continue;
    }
    const s = await get<{ coins?: Coin[] }>(c, `/search?query=${encodeURIComponent(r)}`);
    const exact = (s.coins ?? []).filter((x) => x.symbol.toLowerCase() === r || x.id === r);
    const best = (exact.length ? exact : (s.coins ?? [])).sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
    if (best && !out.includes(best.id)) out.push(best.id);
  }
  return out;
}

const fmt = (n: number, cur: string) =>
  `${n.toLocaleString("es-ES", { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 4 : 8 })} ${cur.toUpperCase()}`;

export async function prices(c: Connection, refs: string[], currency: string): Promise<string> {
  const cur = currency.toLowerCase();
  if (!CURRENCY.test(cur)) throw new Error("Divisa no válida (p. ej. eur, usd).");
  const ids = await resolveCoins(c, refs);
  if (!ids.length) throw new Error("No reconozco ninguna de esas criptomonedas.");
  const q = new URLSearchParams({ ids: ids.join(","), vs_currencies: cur, include_24hr_change: "true", include_last_updated_at: "true" });
  const r = await get<Record<string, Record<string, number>>>(c, `/simple/price?${q}`);
  const lines = ids.map((id) => {
    const p = r[id];
    if (!p || p[cur] === undefined) return `- ${id}: sin datos`;
    const ch = p[`${cur}_24h_change`];
    return `- ${id}: ${fmt(p[cur], cur)}${ch !== undefined ? ` (${ch >= 0 ? "+" : ""}${ch.toFixed(2)} % en 24 h)` : ""}`;
  });
  return [`Precios (CoinGecko, ${cur.toUpperCase()}):`, ...lines].join("\n");
}

export async function searchCoins(c: Connection, text: string): Promise<string> {
  const s = await get<{ coins?: Coin[] }>(c, `/search?query=${encodeURIComponent(text)}`);
  const coins = (s.coins ?? []).slice(0, 10);
  return coins.length ? coins.map((x) => `- ${x.name} (${x.symbol.toUpperCase()}) · id ${x.id}${x.market_cap_rank ? ` · puesto ${x.market_cap_rank}` : ""}`).join("\n") : `Nada con «${text}».`;
}

function cryptoTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const c = grants[0].connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "CoinGecko");
  const defaults = (c.config.monedas as string[]) ?? [];
  return [
    defineTool(
      "cripto_precios",
      `Precio actual y variación en 24 h de criptomonedas (ids o símbolos). Por defecto: ${defaults.join(", ")} en ${String(c.config.divisa).toUpperCase()}.`,
      { monedas: z.array(z.string().max(40)).max(25).optional(), divisa: z.string().max(5).optional() },
      async ({ monedas, divisa }) =>
        run(async () => {
          audit("consulta precios");
          return prices(c, monedas?.length ? monedas : defaults, divisa ?? String(c.config.divisa));
        }),
    ),
    defineTool("cripto_buscar", "Busca el id de CoinGecko de una criptomoneda por nombre o símbolo.", { texto: z.string().min(1).max(60) }, async ({ texto }) =>
      run(async () => {
        audit(`busca «${texto}»`);
        return searchCoins(c, texto);
      }),
    ),
  ];
}

registerService({
  key: "cripto",
  label: "Criptomonedas (CoinGecko)",
  description: "Precios y variación en 24 h de Bitcoin, Ethereum y miles más. Gratis, sin cuenta (clave opcional).",
  category: "finanzas",
  readOnly: true,
  levels: { lectura: "Lectura: consultar precios y buscar monedas", completo: "Completo: igual que lectura" },
  fields: [
    { key: "monedas", label: "Monedas por defecto", placeholder: "bitcoin, ethereum" },
    { key: "divisa", label: "Divisa", placeholder: "eur" },
  ],
  supportsSecret: true,
  secretOptional: true,
  secretLabel: "Clave demo de CoinGecko",
  secretPlaceholder: "CG-…",
  steps: [
    "Escribe las monedas que sigues (ids o símbolos, p. ej. «bitcoin, eth») y la divisa (eur por defecto). Pulsa «Añadir».",
    "Opcional: si haces muchas consultas, crea una clave «Demo» gratis en coingecko.com/es/api y pégala en la ficha (cifrada).",
    "Pulsa «Probar conexión» y da lectura a quien lleve tus finanzas (p. ej. Fina).",
  ],
  normalizeConfig(input) {
    const monedas = listField(input.monedas, 25).map((m) => m.toLowerCase());
    const divisa = String(input.divisa ?? "").trim().toLowerCase() || "eur";
    if (!CURRENCY.test(divisa)) throw new Error("Divisa no válida (p. ej. eur, usd).");
    return { monedas: monedas.length ? monedas : ["bitcoin", "ethereum"], divisa };
  },
  defaultName() {
    return "Criptomonedas";
  },
  tools: cryptoTools,
  prompt() {
    return "Criptomonedas (CoinGecko, datos públicos): cripto_precios y cripto_buscar. Cita la hora de los datos y no des consejos de inversión.";
  },
  test(c) {
    return testWith(c, async () => prices(c, c.config.monedas as string[], String(c.config.divisa)));
  },
});
