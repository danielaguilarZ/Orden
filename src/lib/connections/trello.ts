import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson } from "./http";
import { auditor, canWrite, DailyLimit, guard, pickGrant, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Trello con clave de API (pública, en la configuración) y token (cifrado).
 * Lectura: tableros, listas, tarjetas y búsqueda. Completo: además crear
 * tarjetas y comentar (máx. 50 al día). Nunca mueve, archiva ni borra.
 */

const API = "https://api.trello.com/1";
const SECRET = "token de Trello";
export const trelloLimit = new DailyLimit(50, "cambios en Trello");

interface TBoard {
  id: string;
  name: string;
  url?: string;
}
interface TList {
  id: string;
  name: string;
}
interface TCard {
  id: string;
  name: string;
  idList?: string;
  due?: string | null;
  dueComplete?: boolean;
  url?: string;
  labels?: { name?: string; color?: string }[];
}

function api<T>(c: Connection, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = requireSecret(c, SECRET);
  const key = String(c.config.api_key ?? "");
  return fetchJson<T>(
    `${API}${path}`,
    {
      method: init.method ?? "GET",
      headers: { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`, "Content-Type": "application/json", Accept: "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    { secrets: [token] },
  );
}

const isId = (s: string) => /^[0-9a-f]{24}$/i.test(s);

/** Tablero por id o por nombre (sin distinguir mayúsculas). */
export async function findBoard(c: Connection, ref: string): Promise<TBoard> {
  const boards = await api<TBoard[]>(c, "/members/me/boards?filter=open&fields=name,url");
  const r = ref.trim().toLowerCase();
  const b = boards.find((x) => x.id === ref.trim()) ?? boards.find((x) => x.name.toLowerCase() === r) ?? boards.find((x) => x.name.toLowerCase().includes(r));
  if (!b) throw new Error(`No encuentro el tablero «${ref}». Tableros: ${boards.map((x) => x.name).join(", ") || "ninguno"}.`);
  return b;
}

export const cardLine = (k: TCard, lists?: Map<string, string>) => {
  const bits = [
    k.idList && lists?.get(k.idList) ? `en «${lists.get(k.idList)}»` : null,
    k.due ? `vence ${k.due.slice(0, 10)}${k.dueComplete ? " (hecha)" : ""}` : null,
    k.labels?.filter((l) => l.name).length ? k.labels.filter((l) => l.name).map((l) => `[${l.name}]`).join(" ") : null,
  ].filter(Boolean);
  return `- ${k.name}${bits.length ? ` · ${bits.join(" · ")}` : ""} · id ${k.id}`;
};

export async function boardsText(c: Connection): Promise<string> {
  const boards = await api<TBoard[]>(c, "/members/me/boards?filter=open&fields=name,url");
  return boards.length ? boards.map((b) => `- ${b.name} · id ${b.id}${b.url ? ` · ${b.url}` : ""}`).join("\n") : "No hay tableros abiertos.";
}

export async function boardText(c: Connection, ref: string, listName?: string, max = 50): Promise<string> {
  const b = await findBoard(c, ref);
  const [lists, cards] = await Promise.all([
    api<TList[]>(c, `/boards/${b.id}/lists?filter=open&fields=name`),
    api<TCard[]>(c, `/boards/${b.id}/cards?filter=open&fields=name,idList,due,dueComplete,labels,url`),
  ]);
  const wanted = listName?.trim().toLowerCase();
  const out = [`Tablero «${b.name}»:`];
  for (const l of lists) {
    if (wanted && !l.name.toLowerCase().includes(wanted)) continue;
    const inList = cards.filter((k) => k.idList === l.id).slice(0, max);
    out.push(`\n## ${l.name} (${cards.filter((k) => k.idList === l.id).length}) · id lista ${l.id}`);
    out.push(...(inList.length ? inList.map((k) => cardLine(k)) : ["(vacía)"]));
  }
  if (out.length === 1) out.push(wanted ? `No hay ninguna lista que contenga «${listName}».` : "No tiene listas.");
  return out.join("\n");
}

export async function searchCards(c: Connection, query: string, max = 20): Promise<string> {
  const q = new URLSearchParams({ query, modelTypes: "cards", cards_limit: String(max), card_fields: "name,idList,due,dueComplete,labels,url" });
  const r = await api<{ cards?: TCard[] }>(c, `/search?${q}`);
  const cards = r.cards ?? [];
  return cards.length ? cards.map((k) => cardLine(k)).join("\n") : `Ninguna tarjeta con «${query}».`;
}

/** Lista por id o por nombre dentro de un tablero. */
async function findList(c: Connection, board: string, list: string): Promise<TList> {
  if (isId(list)) return { id: list, name: list };
  const b = await findBoard(c, board);
  const lists = await api<TList[]>(c, `/boards/${b.id}/lists?filter=open&fields=name`);
  const l = lists.find((x) => x.name.toLowerCase() === list.trim().toLowerCase());
  if (!l) throw new Error(`No hay lista «${list}» en «${b.name}». Listas: ${lists.map((x) => x.name).join(", ")}.`);
  return l;
}

export async function createCard(c: Connection, a: { tablero: string; lista: string; titulo: string; descripcion?: string; vence?: string }, at = new Date()): Promise<TCard> {
  trelloLimit.check(c.id, at);
  const l = await findList(c, a.tablero, a.lista);
  const body: Record<string, unknown> = { idList: l.id, name: a.titulo.trim(), pos: "bottom" };
  if (a.descripcion?.trim()) body.desc = a.descripcion.trim();
  if (a.vence?.trim()) {
    if (Number.isNaN(Date.parse(a.vence))) throw new Error("Fecha de vencimiento no válida (usa AAAA-MM-DD o AAAA-MM-DDTHH:MM).");
    body.due = new Date(a.vence).toISOString();
  }
  const card = await api<TCard>(c, "/cards", { method: "POST", body });
  trelloLimit.add(c.id, at);
  return card;
}

export async function commentCard(c: Connection, cardId: string, text: string, at = new Date()): Promise<void> {
  if (!isId(cardId)) throw new Error("Id de tarjeta no válido.");
  trelloLimit.check(c.id, at);
  await api(c, `/cards/${cardId}/actions/comments`, { method: "POST", body: { text: text.trim() } });
  trelloLimit.add(c.id, at);
}

function trelloTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = pickGrant(grants);
  const c = g.connection;
  const audit = auditor(ctx, c, "Trello");
  const run = guard(c);
  const tools: ToolDef[] = [
    defineTool("trello_tableros", "Tus tableros abiertos de Trello (nombre, id y enlace).", {}, async () =>
      run(async () => {
        audit("lista tableros");
        return boardsText(c);
      }),
    ),
    defineTool(
      "trello_tablero",
      "Listas y tarjetas abiertas de un tablero de Trello (por nombre o id). Opcional: solo las listas cuyo nombre contenga «lista».",
      { tablero: z.string().min(1).max(120), lista: z.string().max(120).optional(), max: z.number().int().min(1).max(100).optional() },
      async ({ tablero, lista, max }) =>
        run(async () => {
          audit(`lee el tablero «${tablero}»`);
          return boardText(c, tablero, lista, max ?? 50);
        }),
    ),
    defineTool("trello_buscar", "Busca tarjetas de Trello por texto.", { texto: z.string().min(1).max(200), max: z.number().int().min(1).max(50).optional() }, async ({ texto, max }) =>
      run(async () => {
        audit(`busca «${texto}»`);
        return searchCards(c, texto, max ?? 20);
      }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "trello_crear_tarjeta",
        "Crea una tarjeta al final de una lista de Trello (solo si te lo piden). Tablero y lista por nombre o id.",
        {
          tablero: z.string().min(1).max(120),
          lista: z.string().min(1).max(120),
          titulo: z.string().min(1).max(300),
          descripcion: z.string().max(4000).optional(),
          vence: z.string().max(30).optional().describe("AAAA-MM-DD o AAAA-MM-DDTHH:MM"),
        },
        async (a) =>
          run(async () => {
            const k = await createCard(c, a);
            audit(`crea la tarjeta «${k.name}»`);
            ctx.note(`Trello: tarjeta «${k.name}»`, { kind: "trello" });
            return `Tarjeta creada: ${k.name} · id ${k.id}${k.url ? ` · ${k.url}` : ""}`;
          }),
      ),
      defineTool("trello_comentar", "Añade un comentario a una tarjeta de Trello por su id (solo si te lo piden).", { tarjeta: z.string().min(1).max(40), texto: z.string().min(1).max(4000) }, async ({ tarjeta, texto }) =>
        run(async () => {
          await commentCard(c, tarjeta, texto);
          audit(`comenta en la tarjeta ${tarjeta}`);
          ctx.note(`Trello: comentario en ${tarjeta}`, { kind: "trello" });
          return "Comentario añadido.";
        }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "trello",
  label: "Trello",
  description: "Tus tableros de Trello: ver listas y tarjetas y buscar; con permiso completo, crear tarjetas y comentar.",
  category: "tareas",
  levels: {
    lectura: "Lectura: ver tableros, listas y tarjetas y buscar",
    completo: `Completo: además crear tarjetas y comentar (máx. ${trelloLimit.max} al día; nunca mueve, archiva ni borra)`,
  },
  fields: [{ key: "api_key", label: "Clave de API (API key)", placeholder: "32 caracteres hex" }],
  supportsSecret: true,
  secretLabel: "Token",
  secretPlaceholder: "ATTA…",
  steps: [
    "Entra en trello.com/power-ups/admin → «Nuevo» y crea un Power-Up (nombre «Orden», cualquier espacio de trabajo).",
    "En su pestaña «Clave de API» genera la clave: cópiala aquí y pulsa «Añadir».",
    "En esa misma página pulsa el enlace «Token», autoriza (lectura y escritura si quieres que creen tarjetas) y pega el token en la ficha (se guarda cifrado).",
    "Pulsa «Probar conexión» y da permisos: «Lectura» para consultar, «Completo» para crear tarjetas y comentar.",
  ],
  normalizeConfig(input) {
    const key = String(input.api_key ?? "").trim();
    if (!/^[0-9a-f]{32}$/i.test(key)) throw new Error("La clave de API de Trello son 32 caracteres hexadecimales.");
    return { api_key: key };
  },
  defaultName() {
    return "Trello";
  },
  tools: trelloTools,
  prompt(grants) {
    return `Trello: trello_tableros, trello_tablero y trello_buscar${canWrite(grants) ? "; trello_crear_tarjeta y trello_comentar solo cuando te lo pidan" : ""}.`;
  },
  test(c) {
    return testWith(
      c,
      async () => {
        const me = await api<{ username?: string; fullName?: string }>(c, "/members/me?fields=username,fullName");
        const boards = await api<TBoard[]>(c, "/members/me/boards?filter=open&fields=name");
        return `Trello conectado como ${me.fullName ?? me.username ?? "?"}: ${boards.length} tablero(s) abiertos.`;
      },
      SECRET,
    );
  },
});
