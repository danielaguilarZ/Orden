import { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../agents/tools";
import { logActivity } from "../repo/system";
import { fetchText } from "./http";
import { registerService, type AgentGrant } from "./registry";

/**
 * Noticias por RSS/Atom: las fuentes las elige el usuario (los agentes no
 * pueden añadir direcciones). Solo lectura, sin credenciales.
 */

export const MAX_FEEDS = 15;
const MAX_ITEMS = 30;

export interface FeedItem {
  title: string;
  link: string;
  /** ISO o null si la fuente no trae fecha. */
  date: string | null;
  source: string;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(#39|apos);/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]) : null;
}

/** Lee un RSS 2.0 o un Atom sin dependencias. */
export function parseFeed(xml: string, fallbackSource: string): { title: string; items: FeedItem[] } {
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const title = tag(head, "title") || fallbackSource;
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const items = blocks.map((b) => {
    const atomLink = /<link[^>]*?href="([^"]+)"/i.exec(b)?.[1];
    const link = tag(b, "link") || atomLink || tag(b, "guid") || "";
    const raw = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const t = raw ? Date.parse(raw) : NaN;
    return { title: tag(b, "title") || "(sin título)", link, date: Number.isNaN(t) ? null : new Date(t).toISOString(), source: title };
  });
  return { title, items };
}

/** Lista de fuentes válida (http/https, sin repetidas, máx. 15). */
export function parseFeedList(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[\s,]+/);
  const out: string[] = [];
  for (const r of raw) {
    const s = r.trim();
    if (!s) continue;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error(`«${s}» no es una dirección válida.`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`«${s}»: solo se admiten direcciones http(s).`);
    if (!out.includes(u.href)) out.push(u.href);
  }
  if (!out.length) throw new Error("Añade al menos una dirección RSS o Atom.");
  if (out.length > MAX_FEEDS) throw new Error(`Demasiadas fuentes (máx. ${MAX_FEEDS}).`);
  return out;
}

/** Lee todas las fuentes; las que fallan se informan sin parar el resto. */
export async function readFeeds(feeds: string[]): Promise<{ items: FeedItem[]; errors: string[]; counts: { title: string; n: number }[] }> {
  const results = await Promise.allSettled(feeds.map(async (url) => parseFeed(await fetchText(url, {}, { maxBytes: 3_000_000 }), new URL(url).host)));
  const items: FeedItem[] = [];
  const errors: string[] = [];
  const counts: { title: string; n: number }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      items.push(...r.value.items);
      counts.push({ title: r.value.title, n: r.value.items.length });
    } else errors.push(`${new URL(feeds[i]).host}: ${(r.reason as Error).message}`);
  });
  items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return { items, errors, counts };
}

/** Titulares en texto, filtrados por fuente (parte de la dirección o del nombre). */
export async function headlines(feeds: string[], opts: { source?: string; max?: number } = {}): Promise<string> {
  const filter = opts.source?.trim().toLowerCase();
  // Primero por dirección; si ninguna coincide, se leen todas y se filtra por nombre de la fuente.
  const byUrl = filter ? feeds.filter((f) => f.toLowerCase().includes(filter)) : feeds;
  const { items, errors } = await readFeeds(byUrl.length ? byUrl : feeds);
  const matching = filter && !byUrl.length ? items.filter((it) => it.source.toLowerCase().includes(filter)) : items;
  const shown = matching.slice(0, Math.min(opts.max ?? 10, MAX_ITEMS));
  const lines = shown.map((it) => `- ${it.date ? `${it.date.slice(0, 10)} · ` : ""}${it.title} — ${it.source}${it.link ? `\n  ${it.link}` : ""}`);
  if (!lines.length) lines.push("No hay noticias con ese filtro.");
  if (errors.length) lines.push(`(No se pudo leer: ${errors.join("; ")})`);
  return lines.join("\n");
}

const feedsOf = (g: AgentGrant) => (Array.isArray(g.connection.config.feeds) ? (g.connection.config.feeds as string[]) : []);

function rssTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const feeds = [...new Set(grants.flatMap(feedsOf))];
  return [
    defineTool(
      "noticias_titulares",
      "Últimos titulares de las fuentes RSS que ha elegido el usuario (los más recientes primero). Filtra por fuente si quieres.",
      {
        fuente: z.string().max(80).optional().describe("Parte de la dirección o del nombre de la fuente"),
        max: z.number().int().min(1).max(MAX_ITEMS).optional().describe("Cuántos titulares (por defecto 10)"),
      },
      async ({ fuente, max }) => {
        try {
          const text = await headlines(feeds, { source: fuente, max });
          logActivity("conexion", `${ctx.agent.name} lee titulares${fuente ? ` de «${fuente}»` : ""}`, ctx.agent.id, { connectionId: grants[0].connection.id, taskId: ctx.task.id });
          return ok(text);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
  ];
}

registerService({
  key: "rss",
  label: "Noticias (RSS)",
  description: "Titulares de los periódicos, blogs o podcasts que elijas, por RSS o Atom. Sin cuenta.",
  levels: { lectura: "Lectura: leer los titulares de tus fuentes", completo: "Completo: igual que lectura (no hay nada que escribir)" },
  fields: [{ key: "feeds", label: "Direcciones RSS (separadas por comas)", placeholder: "https://…/rss, https://…/feed" }],
  supportsSecret: false,
  readOnly: true,
  steps: [
    "Busca la dirección RSS de cada medio (suele estar en el pie de la web como «RSS» o terminar en /rss o /feed).",
    `Pega una o varias, separadas por comas (máx. ${MAX_FEEDS}), y pulsa «Añadir».`,
    "Pulsa «Probar conexión» para ver cuántas noticias trae cada fuente.",
    "Da permiso de lectura a los agentes que te preparen resúmenes.",
  ],
  normalizeConfig(input) {
    return { feeds: parseFeedList(input.feeds) };
  },
  defaultName(config) {
    const feeds = config.feeds as string[];
    return feeds.length === 1 ? `Noticias · ${new URL(feeds[0]).host}` : `Noticias · ${feeds.length} fuentes`;
  },
  tools: rssTools,
  prompt(grants) {
    const n = new Set(grants.flatMap(feedsOf)).size;
    return `Noticias (RSS): lee los titulares de las ${n} fuente${n === 1 ? "" : "s"} del usuario con noticias_titulares. Resume sin inventar y cita la fuente.`;
  },
  async test(c) {
    const { counts, errors } = await readFeeds(c.config.feeds as string[]);
    const parts = counts.map((x) => `${x.title} (${x.n})`);
    return {
      ok: counts.length > 0,
      text: `${counts.length} de ${counts.length + errors.length} fuentes leídas${parts.length ? `: ${parts.join(", ")}` : ""}.${errors.length ? ` Fallan: ${errors.join("; ")}` : ""}`,
    };
  },
});
