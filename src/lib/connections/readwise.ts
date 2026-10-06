import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson, fetchText } from "./http";
import { auditor, canWrite, clip, DailyLimit, guard, pickGrant, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Readwise (subrayados de libros y artículos) y Readwise Reader (lo que
 * tienes para leer). Lectura: subrayados recientes o por texto y la lista de
 * Reader. Completo: además guardar enlaces en Reader (máx. 30 al día).
 */

const API = "https://readwise.io/api";
const SECRET = "token de Readwise";
export const readwiseLimit = new DailyLimit(30, "enlaces guardados en Readwise");

function call<T>(c: Connection, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = requireSecret(c, SECRET);
  return fetchJson<T>(
    `${API}${path}`,
    { method: init.method ?? "GET", headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    { secrets: [token], maxBytes: 8_000_000 },
  );
}

interface ExportBook {
  title: string;
  author?: string | null;
  source_url?: string | null;
  highlights: { text: string; note?: string | null; highlighted_at?: string | null }[];
}

/** Subrayados de los últimos `days` días (o con `text`), agrupados por libro/artículo. */
export async function highlights(c: Connection, opts: { text?: string; days?: number; max?: number } = {}): Promise<string> {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86_400_000).toISOString();
  const r = await call<{ results: ExportBook[] }>(c, `/v2/export/?updatedAfter=${encodeURIComponent(since)}`);
  const q = opts.text?.trim().toLowerCase();
  const max = opts.max ?? 30;
  const out: string[] = [];
  let n = 0;
  for (const b of r.results) {
    const hs = b.highlights.filter((h) => !q || `${h.text} ${h.note ?? ""} ${b.title}`.toLowerCase().includes(q));
    if (!hs.length || n >= max) continue;
    out.push(`## ${b.title}${b.author ? ` — ${b.author}` : ""}`);
    for (const h of hs.slice(0, max - n)) {
      out.push(`- «${clip(h.text.trim(), 600)}»${h.note ? `\n  Nota: ${clip(h.note, 300)}` : ""}`);
      n++;
    }
  }
  return out.length ? out.join("\n") : `No hay subrayados${q ? ` con «${opts.text}»` : ""} en los últimos ${opts.days ?? 30} días.`;
}

interface ReaderDoc {
  title?: string | null;
  author?: string | null;
  source_url?: string | null;
  url?: string;
  category?: string;
  location?: string;
  reading_progress?: number;
  saved_at?: string;
  summary?: string | null;
}

export async function readerList(c: Connection, location = "later", max = 20): Promise<string> {
  const r = await call<{ results: ReaderDoc[] }>(c, `/v3/list/?location=${encodeURIComponent(location)}`);
  const docs = r.results.slice(0, max);
  if (!docs.length) return `No hay documentos en «${location}».`;
  return docs
    .map(
      (d) =>
        `- ${d.title ?? "(sin título)"}${d.author ? ` — ${d.author}` : ""} · ${d.category ?? "?"}${d.reading_progress ? ` · leído ${Math.round(d.reading_progress * 100)} %` : ""}${d.source_url ? `\n  ${d.source_url}` : ""}${d.summary ? `\n  ${clip(d.summary, 240)}` : ""}`,
    )
    .join("\n");
}

export async function saveToReader(c: Connection, url: string, title?: string, tags?: string[], at = new Date()): Promise<string> {
  if (!/^https?:\/\/\S+$/.test(url.trim())) throw new Error("El enlace debe empezar por http(s)://");
  readwiseLimit.check(c.id, at);
  const body: Record<string, unknown> = { url: url.trim(), location: "later", saved_using: "Orden" };
  if (title?.trim()) body.title = title.trim();
  if (tags?.length) body.tags = tags;
  const r = await call<{ id?: string; url?: string }>(c, "/v3/save/", { method: "POST", body });
  readwiseLimit.add(c.id, at);
  return r.url ?? url;
}

function readwiseTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = pickGrant(grants);
  const c = g.connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Readwise");
  const tools: ToolDef[] = [
    defineTool(
      "readwise_subrayados",
      "Subrayados y notas del usuario en Readwise (libros, Kindle, artículos), de los últimos días o con un texto.",
      { texto: z.string().max(100).optional(), dias: z.number().int().min(1).max(3650).optional().describe("Por defecto 30"), max: z.number().int().min(1).max(100).optional() },
      async ({ texto, dias, max }) =>
        run(async () => {
          audit(`lee subrayados${texto ? ` («${texto}»)` : ""}`);
          return highlights(c, { text: texto, days: dias, max });
        }),
    ),
    defineTool(
      "readwise_reader",
      "Documentos guardados en Readwise Reader: «new» (bandeja), «later» (para después, por defecto), «shortlist», «archive» o «feed».",
      { ubicacion: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(), max: z.number().int().min(1).max(100).optional() },
      async ({ ubicacion, max }) =>
        run(async () => {
          audit(`lista Reader (${ubicacion ?? "later"})`);
          return readerList(c, ubicacion ?? "later", max ?? 20);
        }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "readwise_guardar",
        `Guarda un enlace en Readwise Reader para leer después (solo si te lo piden; máx. ${readwiseLimit.max} al día).`,
        { enlace: z.string().max(2000), titulo: z.string().max(300).optional(), etiquetas: z.array(z.string().max(40)).max(10).optional() },
        async ({ enlace, titulo, etiquetas }) =>
          run(async () => {
            const u = await saveToReader(c, enlace, titulo, etiquetas);
            audit(`guarda ${enlace}`);
            ctx.note(`Readwise: guardado ${titulo ?? enlace}`, { kind: "readwise" });
            return `Guardado en Reader: ${u}`;
          }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "readwise",
  label: "Readwise / Reader",
  description: "Tus subrayados de libros y artículos y tu lista de lectura de Reader; con permiso completo, guardar enlaces para leer después.",
  category: "notas",
  icon: "🔖",
  levels: {
    lectura: "Lectura: subrayados, notas y lista de Reader",
    completo: `Completo: además guardar enlaces en Reader (máx. ${readwiseLimit.max} al día)`,
  },
  fields: [],
  supportsSecret: true,
  secretLabel: "Token de acceso",
  secretPlaceholder: "abc123…",
  steps: [
    "Entra en readwise.io/access_token y copia tu token.",
    "Pulsa «Añadir» aquí y pega el token en la ficha (se guarda cifrado).",
    "Pulsa «Probar conexión» y da «Lectura» (o «Completo» si quieres que guarden enlaces en Reader).",
  ],
  normalizeConfig() {
    return {};
  },
  defaultName() {
    return "Readwise";
  },
  tools: readwiseTools,
  prompt(grants) {
    return `Readwise: readwise_subrayados y readwise_reader${canWrite(grants) ? "; readwise_guardar solo si te lo piden" : ""}. Cita el libro o artículo de cada subrayado.`;
  },
  test(c) {
    return testWith(
      c,
      async (token) => {
        await fetchText(`${API}/v2/auth/`, { headers: { Authorization: `Token ${token}` } }, { secrets: [token] });
        return "Token de Readwise válido.";
      },
      SECRET,
    );
  },
});
