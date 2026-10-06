import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import { fetchJson } from "./http";
import { auditor, clip, guard, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/** Wikipedia: buscar artículos y leer su resumen. Datos públicos, sin claves. Solo lectura. */

const HEADERS = { Accept: "application/json", "Api-User-Agent": "Orden/1.0 (asistente personal local)" };
const LANG = /^[a-z]{2,3}(-[a-z]+)?$/;

const host = (lang: string) => `https://${lang}.wikipedia.org`;
const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'");

export async function searchWiki(lang: string, text: string, max = 5): Promise<string> {
  const q = new URLSearchParams({ action: "query", list: "search", srsearch: text, srlimit: String(max), format: "json", utf8: "1", origin: "*" });
  const r = await fetchJson<{ query?: { search?: { title: string; snippet?: string }[] } }>(`${host(lang)}/w/api.php?${q}`, { headers: HEADERS });
  const list = r.query?.search ?? [];
  return list.length ? list.map((x) => `- ${x.title}${x.snippet ? `: ${clip(strip(x.snippet), 200)}` : ""}`).join("\n") : `Nada en Wikipedia (${lang}) con «${text}».`;
}

export async function summaryWiki(lang: string, title: string): Promise<string> {
  const r = await fetchJson<{ title: string; description?: string; extract?: string; content_urls?: { desktop?: { page?: string } }; type?: string }>(
    `${host(lang)}/api/rest_v1/page/summary/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`,
    { headers: HEADERS },
  );
  if (r.type === "disambiguation") return `«${r.title}» es una página de desambiguación: busca un título más concreto con wikipedia_buscar.`;
  return `${r.title}${r.description ? ` (${r.description})` : ""}\n${r.extract ?? "(sin resumen)"}${r.content_urls?.desktop?.page ? `\nFuente: ${r.content_urls.desktop.page}` : ""}`;
}

function wikiTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const c = grants[0].connection;
  const lang = String(c.config.idioma);
  const run = guard(c);
  const audit = auditor(ctx, c, "Wikipedia");
  const langArg = z.string().regex(LANG).optional().describe(`Idioma (por defecto ${lang})`);
  return [
    defineTool("wikipedia_buscar", "Busca artículos en Wikipedia.", { texto: z.string().min(1).max(200), idioma: langArg, max: z.number().int().min(1).max(20).optional() }, async ({ texto, idioma, max }) =>
      run(async () => {
        audit(`busca «${texto}»`);
        return searchWiki(idioma ?? lang, texto, max ?? 5);
      }),
    ),
    defineTool("wikipedia_resumen", "Resumen de un artículo de Wikipedia por su título exacto (con el enlace para citarlo).", { titulo: z.string().min(1).max(200), idioma: langArg }, async ({ titulo, idioma }) =>
      run(async () => {
        audit(`lee «${titulo}»`);
        return summaryWiki(idioma ?? lang, titulo);
      }),
    ),
  ];
}

registerService({
  key: "wikipedia",
  label: "Wikipedia",
  description: "Buscar artículos y leer su resumen para responder con fuente. Gratis y sin claves.",
  category: "info",
  readOnly: true,
  levels: { lectura: "Lectura: buscar y leer resúmenes", completo: "Completo: igual que lectura" },
  fields: [{ key: "idioma", label: "Idioma", placeholder: "es" }],
  supportsSecret: false,
  steps: ["Elige el idioma (es por defecto) y pulsa «Añadir».", "Pulsa «Probar conexión».", "Da lectura a los agentes que investiguen o resuman."],
  normalizeConfig(input) {
    const idioma = String(input.idioma ?? "").trim().toLowerCase() || "es";
    if (!LANG.test(idioma)) throw new Error("Idioma no válido (p. ej. es, en, ca).");
    return { idioma };
  },
  defaultName(config) {
    return `Wikipedia · ${String(config.idioma)}`;
  },
  tools: wikiTools,
  prompt() {
    return "Wikipedia: wikipedia_buscar y wikipedia_resumen. Cita el enlace cuando lo uses.";
  },
  test(c) {
    return testWith(c, async () => clip(await summaryWiki(String(c.config.idioma), "Wikipedia"), 200));
  },
});
