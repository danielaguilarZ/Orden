import { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../agents/tools";
import { getConnectionSecret, type Connection } from "../repo/connections";
import { logActivity } from "../repo/system";
import { redact } from "../secrets";
import { fetchJson } from "./http";
import { registerService, type AgentGrant } from "./registry";

/**
 * Notion con una integración interna del usuario: solo ve las páginas que él
 * comparte con ella. Lectura: buscar y leer. Completo: además, añadir texto
 * al final de una página (nunca borra ni cambia lo que hay).
 */

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MAX_READ_CHARS = 8000;
const MAX_APPEND_BLOCKS = 50;
const MAX_BLOCK_CHARS = 2000;

type RichText = { plain_text?: string }[] | undefined;
const rt = (r: RichText) => (r ?? []).map((x) => x.plain_text ?? "").join("");

function tokenOf(c: Connection): string {
  const token = getConnectionSecret(c.id);
  if (!token) throw new Error("Falta el secreto de la integración: pégalo en la ficha de la conexión.");
  return token;
}

async function notion<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return fetchJson<T>(
    `${API}${path}`,
    {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    { secrets: [token] },
  );
}

/** Id de página a partir de un id (con o sin guiones) o de un enlace de Notion. */
export function pageId(ref: string): string {
  // El id va al final del enlace («Mi-pagina-<32 hex>»): últimos 32 del último tramo hexadecimal.
  const hex = ref
    .replace(/-/g, "")
    .match(/[0-9a-f]{32,}/gi)
    ?.at(-1)
    ?.slice(-32)
    .toLowerCase();
  if (!hex) throw new Error("Id o enlace de Notion no válido.");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface NObject {
  object: string;
  id: string;
  url?: string;
  title?: RichText;
  properties?: Record<string, { type: string; title?: RichText }>;
}

export function titleOf(o: NObject): string {
  if (o.object === "database") return rt(o.title) || "(sin título)";
  for (const p of Object.values(o.properties ?? {})) if (p.type === "title") return rt(p.title) || "(sin título)";
  return "(sin título)";
}

interface NBlock {
  id: string;
  type: string;
  [k: string]: unknown;
}

/** Bloques de Notion → texto tipo markdown. */
export function blocksToText(blocks: NBlock[]): string {
  return blocks
    .map((b) => {
      const v = b[b.type] as { rich_text?: RichText; checked?: boolean; title?: string } | undefined;
      if (!v) return "";
      const text = rt(v.rich_text);
      switch (b.type) {
        case "heading_1":
          return `# ${text}`;
        case "heading_2":
          return `## ${text}`;
        case "heading_3":
          return `### ${text}`;
        case "bulleted_list_item":
          return `- ${text}`;
        case "numbered_list_item":
          return `1. ${text}`;
        case "to_do":
          return `- [${v.checked ? "x" : " "}] ${text}`;
        case "quote":
          return `> ${text}`;
        case "code":
          return `\`\`\`\n${text}\n\`\`\``;
        case "child_page":
          return `Subpágina «${v.title ?? ""}» (id ${b.id})`;
        case "child_database":
          return `Base de datos «${v.title ?? ""}» (id ${b.id})`;
        default:
          return text;
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** Texto → bloques de párrafo (uno por párrafo, troceados a 2000 caracteres). */
export function textToBlocks(text: string): unknown[] {
  const chunks: string[] = [];
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    for (let i = 0; i < para.length; i += MAX_BLOCK_CHARS) chunks.push(para.slice(i, i + MAX_BLOCK_CHARS));
  }
  if (!chunks.length) throw new Error("No hay texto que añadir.");
  if (chunks.length > MAX_APPEND_BLOCKS) throw new Error(`Demasiado texto de una vez (máx. ${MAX_APPEND_BLOCKS} párrafos).`);
  return chunks.map((content) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } }));
}

export async function searchNotion(c: Connection, query: string, max = 10): Promise<string> {
  const token = tokenOf(c);
  const r = await notion<{ results: NObject[] }>(token, "/search", { method: "POST", body: { query, page_size: Math.min(20, Math.max(1, max)) } });
  if (!r.results.length) return "Nada encontrado. Recuerda: solo veo las páginas compartidas con la integración.";
  return r.results.map((o) => `- «${titleOf(o)}» · ${o.object === "database" ? "base de datos" : "página"} · id ${o.id}${o.url ? ` · ${o.url}` : ""}`).join("\n");
}

export async function readNotionPage(c: Connection, ref: string): Promise<string> {
  const token = tokenOf(c);
  const r = await notion<{ results: NBlock[]; has_more?: boolean }>(token, `/blocks/${pageId(ref)}/children?page_size=100`);
  const text = blocksToText(r.results);
  const cut = text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…` : text;
  return (cut || "(página vacía)") + (r.has_more ? "\n(… la página sigue; solo se muestran los primeros 100 bloques)" : "");
}

export async function appendToNotion(c: Connection, ref: string, text: string): Promise<number> {
  const token = tokenOf(c);
  const children = textToBlocks(text);
  await notion(token, `/blocks/${pageId(ref)}/children`, { method: "PATCH", body: { children } });
  return children.length;
}

function notionTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = grants.find((x) => x.level === "completo") ?? grants[0];
  const c = g.connection;
  const audit = (text: string) => logActivity("conexion", `${ctx.agent.name} en Notion: ${text}`, ctx.agent.id, { connectionId: c.id, taskId: ctx.task.id });
  const guard = async (fn: () => Promise<string>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(redact((err as Error).message));
    }
  };
  const tools: ToolDef[] = [
    defineTool(
      "notion_buscar",
      "Busca páginas y bases de datos de Notion por título (solo las compartidas con la integración).",
      { texto: z.string().max(200), max: z.number().int().min(1).max(20).optional() },
      async ({ texto, max }) =>
        guard(async () => {
          audit(`busca «${texto}»`);
          return searchNotion(c, texto, max ?? 10);
        }),
    ),
    defineTool(
      "notion_leer",
      "Lee el contenido de una página de Notion como texto (id o enlace).",
      { pagina: z.string().describe("Id o enlace de la página") },
      async ({ pagina }) =>
        guard(async () => {
          audit(`lee ${pageId(pagina)}`);
          return readNotionPage(c, pagina);
        }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "notion_anadir",
        `Añade texto al FINAL de una página de Notion (párrafos separados por línea en blanco; máx. ${MAX_APPEND_BLOCKS}). No borra ni cambia lo que ya hay.`,
        { pagina: z.string().describe("Id o enlace de la página"), texto: z.string().min(1).max(MAX_APPEND_BLOCKS * MAX_BLOCK_CHARS) },
        async ({ pagina, texto }) =>
          guard(async () => {
            const n = await appendToNotion(c, pagina, texto);
            audit(`añade ${n} párrafo${n === 1 ? "" : "s"} a ${pageId(pagina)}`);
            ctx.note(`Notion: añadido texto a una página`, { kind: "notion" });
            return `Añadido${n > 1 ? `s ${n} párrafos` : " 1 párrafo"} al final de la página.`;
          }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "notion",
  label: "Notion",
  description: "Tus páginas de Notion: buscar y leer; con permiso completo, añadir texto al final. Solo ve lo que compartas con la integración.",
  levels: {
    lectura: "Lectura: buscar páginas y leer su contenido",
    completo: "Completo: lo anterior y añadir texto al final de una página (nunca borra)",
  },
  fields: [{ key: "espacio", label: "Nombre (opcional)", placeholder: "Personal" }],
  supportsSecret: true,
  secretLabel: "Secreto de la integración",
  secretPlaceholder: "ntn_…",
  steps: [
    "Entra en notion.so/my-integrations → «Nueva integración» (tipo interna) en tu espacio.",
    "En «Capacidades» deja «Leer contenido»; marca «Insertar contenido» solo si algún agente debe poder añadir texto.",
    "Pulsa «Añadir» aquí y pega en la ficha el «Secreto de integración interna» (se guarda cifrado).",
    "En Notion, en cada página que quieras compartir: «⋯» → «Conexiones» → elige tu integración. Solo verá esas páginas.",
    "Pulsa «Probar conexión» y da permisos: «Lectura» para buscar y leer, «Completo» para añadir texto.",
  ],
  normalizeConfig(input) {
    return { espacio: String(input.espacio ?? "").trim().slice(0, 60) || "Notion" };
  },
  defaultName(config) {
    return config.espacio === "Notion" ? "Notion" : `Notion · ${String(config.espacio)}`;
  },
  tools: notionTools,
  prompt(grants) {
    const write = grants.some((g) => g.level === "completo");
    return `Notion (solo las páginas que el usuario ha compartido con la integración): notion_buscar y notion_leer${write ? "; notion_anadir añade texto al final de una página (no borra nada; úsalo solo si te lo piden)" : ""}.`;
  },
  async test(c) {
    let token: string | null = null;
    try {
      token = tokenOf(c);
      const me = await notion<{ name?: string; bot?: { workspace_name?: string } }>(token, "/users/me");
      return { ok: true, text: `Integración «${me.name ?? "?"}» conectada${me.bot?.workspace_name ? ` al espacio «${me.bot.workspace_name}»` : ""}. Solo verá las páginas que compartas con ella.` };
    } catch (err) {
      return { ok: false, text: redact((err as Error).message, token) };
    }
  },
});
