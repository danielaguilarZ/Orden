import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson } from "./http";
import { auditor, canWrite, clip, DailyLimit, guard, pickGrant, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Marcadores de Raindrop.io (la alternativa a Pocket, que cerró en 2025).
 * Lectura: buscar marcadores y ver colecciones. Completo: además guardar
 * enlaces (máx. 30 al día). Nunca borra.
 */

const API = "https://api.raindrop.io/rest/v1";
const SECRET = "token de Raindrop";
export const raindropLimit = new DailyLimit(30, "marcadores guardados en Raindrop");

function call<T>(c: Connection, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = requireSecret(c, SECRET);
  return fetchJson<T>(
    `${API}${path}`,
    { method: init.method ?? "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    { secrets: [token] },
  );
}

interface Drop {
  _id: number;
  title?: string;
  link: string;
  excerpt?: string;
  tags?: string[];
  created?: string;
}

export const dropLine = (d: Drop) =>
  `- ${d.title || d.link}${d.tags?.length ? ` · ${d.tags.map((t) => `#${t}`).join(" ")}` : ""}${d.created ? ` · ${d.created.slice(0, 10)}` : ""}\n  ${d.link}${d.excerpt ? `\n  ${clip(d.excerpt, 200)}` : ""}`;

export async function searchDrops(c: Connection, text = "", collection = 0, max = 20): Promise<string> {
  const q = new URLSearchParams({ perpage: String(Math.min(50, max)), sort: "-created" });
  if (text.trim()) q.set("search", text.trim());
  const r = await call<{ items: Drop[] }>(c, `/raindrops/${collection}?${q}`);
  return r.items.length ? r.items.map(dropLine).join("\n") : `Ningún marcador${text ? ` con «${text}»` : ""}.`;
}

export async function collections(c: Connection): Promise<string> {
  const [root, children] = await Promise.all([call<{ items: { _id: number; title: string; count?: number }[] }>(c, "/collections"), call<{ items: { _id: number; title: string; count?: number }[] }>(c, "/collections/childrens")]);
  const all = [...root.items, ...children.items];
  return all.length ? all.map((x) => `- ${x.title} · id ${x._id}${x.count !== undefined ? ` · ${x.count} marcadores` : ""}`).join("\n") : "No hay colecciones.";
}

export async function saveDrop(c: Connection, a: { enlace: string; titulo?: string; etiquetas?: string[]; coleccion?: number }, at = new Date()): Promise<Drop> {
  if (!/^https?:\/\/\S+$/.test(a.enlace.trim())) throw new Error("El enlace debe empezar por http(s)://");
  raindropLimit.check(c.id, at);
  const body: Record<string, unknown> = { link: a.enlace.trim(), pleaseParse: {} };
  if (a.titulo?.trim()) body.title = a.titulo.trim();
  if (a.etiquetas?.length) body.tags = a.etiquetas;
  if (a.coleccion) body.collection = { $id: a.coleccion };
  const r = await call<{ result: boolean; item?: Drop; errorMessage?: string }>(c, "/raindrop", { method: "POST", body });
  if (!r.result || !r.item) throw new Error(`Raindrop no pudo guardarlo${r.errorMessage ? `: ${r.errorMessage}` : ""}.`);
  raindropLimit.add(c.id, at);
  return r.item;
}

function raindropTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = pickGrant(grants);
  const c = g.connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Raindrop");
  const tools: ToolDef[] = [
    defineTool(
      "marcadores_buscar",
      "Busca en los marcadores de Raindrop del usuario (texto, #etiqueta…); sin texto, los últimos guardados.",
      { texto: z.string().max(200).optional(), coleccion: z.number().int().optional().describe("Id de colección (por defecto, todas)"), max: z.number().int().min(1).max(50).optional() },
      async ({ texto, coleccion, max }) =>
        run(async () => {
          audit(`busca «${texto ?? ""}»`);
          return searchDrops(c, texto ?? "", coleccion ?? 0, max ?? 20);
        }),
    ),
    defineTool("marcadores_colecciones", "Colecciones de Raindrop (nombre, id y número de marcadores).", {}, async () =>
      run(async () => {
        audit("lista colecciones");
        return collections(c);
      }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "marcadores_guardar",
        `Guarda un enlace en Raindrop (solo si te lo piden; máx. ${raindropLimit.max} al día).`,
        { enlace: z.string().max(2000), titulo: z.string().max(300).optional(), etiquetas: z.array(z.string().max(40)).max(10).optional(), coleccion: z.number().int().optional() },
        async (a) =>
          run(async () => {
            const d = await saveDrop(c, a);
            audit(`guarda ${a.enlace}`);
            ctx.note(`Raindrop: guardado ${d.title ?? a.enlace}`, { kind: "raindrop" });
            return `Guardado: ${d.title ?? d.link} · id ${d._id}`;
          }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "raindrop",
  label: "Raindrop.io (marcadores)",
  description: "Tus marcadores y enlaces para leer después (sustituye a Pocket, que cerró en 2025); con permiso completo, guardar enlaces.",
  category: "notas",
  icon: "💧",
  levels: {
    lectura: "Lectura: buscar marcadores y ver colecciones",
    completo: `Completo: además guardar enlaces (máx. ${raindropLimit.max} al día; nunca borra)`,
  },
  fields: [],
  supportsSecret: true,
  secretLabel: "Token de prueba",
  secretPlaceholder: "xxxxxxxx-xxxx-…",
  steps: [
    "Entra en app.raindrop.io/settings/integrations → «Para desarrolladores» → «Crear nueva aplicación» (nombre «Orden»).",
    "Abre la aplicación y pulsa «Crear token de prueba» (test token): cópialo.",
    "Pulsa «Añadir» aquí y pega el token en la ficha (se guarda cifrado); después «Probar conexión».",
  ],
  normalizeConfig() {
    return {};
  },
  defaultName() {
    return "Raindrop";
  },
  tools: raindropTools,
  prompt(grants) {
    return `Marcadores (Raindrop): marcadores_buscar y marcadores_colecciones${canWrite(grants) ? "; marcadores_guardar solo si te lo piden" : ""}.`;
  },
  test(c) {
    return testWith(
      c,
      async () => {
        const r = await call<{ user?: { fullName?: string; email?: string } }>(c, "/user");
        return `Raindrop conectado como ${r.user?.fullName ?? r.user?.email ?? "?"}.`;
      },
      SECRET,
    );
  },
});
