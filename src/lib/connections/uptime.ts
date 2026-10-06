import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import { auditor, guard, listField, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Monitor de webs: comprueba si tus webs (o las de tus clientes) responden,
 * con qué código y en cuánto tiempo. Sin claves. Solo lectura.
 */

export const MAX_SITES = 20;
const TIMEOUT_MS = 15_000;

export interface SiteCheck {
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

export async function checkSite(url: string): Promise<SiteCheck> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "Orden-monitor/1.0" } });
    void res.body?.cancel();
    return { url, ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (err) {
    const e = err as Error;
    return { url, ok: false, status: null, ms: Date.now() - t0, error: e.name === "TimeoutError" ? `sin respuesta en ${TIMEOUT_MS / 1000} s` : e.message };
  }
}

export const checkLine = (r: SiteCheck) =>
  `- ${r.ok ? "✅" : "❌"} ${r.url} · ${r.status ? `código ${r.status}` : (r.error ?? "error")} · ${r.ms} ms${r.ok && r.ms > 3000 ? " (lenta)" : ""}`;

export async function checkSites(urls: string[]): Promise<string> {
  const res = await Promise.all(urls.map(checkSite));
  const down = res.filter((r) => !r.ok).length;
  return [`${res.length - down} de ${res.length} webs responden bien${down ? `; ${down} con problemas` : ""}:`, ...res.map(checkLine)].join("\n");
}

function uptimeTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const c = grants[0].connection;
  const sites = c.config.webs as string[];
  const run = guard(c);
  const audit = auditor(ctx, c, "Monitor de webs");
  return [
    defineTool(
      "webs_estado",
      `Comprueba si responden las webs vigiladas (${sites.length}): código HTTP y tiempo. Filtra por parte de la dirección si quieres.`,
      { filtro: z.string().max(100).optional() },
      async ({ filtro }) =>
        run(async () => {
          const list = filtro ? sites.filter((s) => s.includes(filtro)) : sites;
          if (!list.length) throw new Error(`Ninguna web vigilada contiene «${filtro}».`);
          audit(`comprueba ${list.length} web(s)`);
          return checkSites(list);
        }),
    ),
  ];
}

registerService({
  key: "monitor_webs",
  label: "Monitor de webs",
  description: "Comprueba si tus webs (o las de tus clientes) están en línea, con su código y tiempo de respuesta. Sin claves.",
  category: "dev",
  icon: "📡",
  readOnly: true,
  levels: { lectura: "Lectura: comprobar el estado de las webs", completo: "Completo: igual que lectura" },
  fields: [{ key: "webs", label: "Direcciones (separadas por comas)", placeholder: "https://miweb.es, https://cliente.com" }],
  supportsSecret: false,
  steps: [
    `Pega las direcciones que quieres vigilar (máx. ${MAX_SITES}) y pulsa «Añadir».`,
    "Pulsa «Probar conexión» para ver cuáles responden.",
    "Da lectura a quien deba vigilarlas; con una rutina diaria («comprueba las webs y avísame si alguna falla») tendrás un aviso automático.",
  ],
  normalizeConfig(input) {
    const webs: string[] = [];
    for (const raw of listField(String(input.webs ?? "").replace(/\s+/g, ","), 100)) {
      let u: URL;
      try {
        u = new URL(raw.includes("://") ? raw : `https://${raw}`);
      } catch {
        throw new Error(`«${raw}» no es una dirección válida.`);
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`«${raw}»: solo se admiten direcciones http(s).`);
      if (!webs.includes(u.href)) webs.push(u.href);
    }
    if (!webs.length) throw new Error("Añade al menos una dirección.");
    if (webs.length > MAX_SITES) throw new Error(`Demasiadas webs (máx. ${MAX_SITES}).`);
    return { webs };
  },
  defaultName(config) {
    const w = config.webs as string[];
    return w.length === 1 ? `Monitor · ${new URL(w[0]).host}` : `Monitor · ${w.length} webs`;
  },
  tools: uptimeTools,
  prompt() {
    return "Monitor de webs: webs_estado comprueba si responden las webs vigiladas.";
  },
  test(c) {
    return testWith(c, async () => checkSites(c.config.webs as string[]));
  },
});
