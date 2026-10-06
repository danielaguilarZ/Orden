import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson } from "./http";
import { auditor, canWrite, DailyLimit, guard, pickGrant, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Linear con una clave de API personal (GraphQL). Lectura: tus issues
 * asignados, buscar y ver equipos. Completo: además crear issues y comentar
 * (máx. 30 al día). Nunca cierra ni borra.
 */

const API = "https://api.linear.app/graphql";
const SECRET = "clave de API de Linear";
export const linearLimit = new DailyLimit(30, "cambios en Linear");

export interface LIssue {
  identifier: string;
  title: string;
  url?: string;
  priority?: number;
  dueDate?: string | null;
  state?: { name: string } | null;
  team?: { key: string } | null;
  assignee?: { name: string } | null;
}

const ISSUE_FIELDS = "identifier title url priority dueDate state { name } team { key } assignee { name }";
const PRIORITY = ["sin prioridad", "urgente", "alta", "media", "baja"];

export async function gql<T>(c: Connection, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const key = requireSecret(c, SECRET);
  const r = await fetchJson<{ data?: T; errors?: { message: string }[] }>(
    API,
    { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) },
    { secrets: [key] },
  );
  if (r.errors?.length) throw new Error(`Linear: ${r.errors.map((e) => e.message).join("; ")}`);
  if (!r.data) throw new Error("Linear no devolvió datos.");
  return r.data;
}

export function issueLine(i: LIssue): string {
  const bits = [
    i.state?.name,
    i.priority ? PRIORITY[i.priority] : null,
    i.dueDate ? `vence ${i.dueDate}` : null,
    i.assignee?.name ? `para ${i.assignee.name}` : null,
  ].filter(Boolean);
  return `- ${i.identifier} ${i.title}${bits.length ? ` · ${bits.join(" · ")}` : ""}${i.url ? ` · ${i.url}` : ""}`;
}

export async function myIssues(c: Connection, max = 25): Promise<string> {
  const d = await gql<{ viewer: { name: string; assignedIssues: { nodes: LIssue[] } } }>(
    c,
    `query($n: Int!) { viewer { name assignedIssues(first: $n, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } } }`,
    { n: max },
  );
  const list = d.viewer.assignedIssues.nodes;
  return list.length ? [`${list.length} issue(s) abiertos asignados a ${d.viewer.name}:`, ...list.map(issueLine)].join("\n") : `${d.viewer.name} no tiene issues abiertos asignados.`;
}

export async function searchIssues(c: Connection, text: string, max = 20): Promise<string> {
  const d = await gql<{ issues: { nodes: LIssue[] } }>(
    c,
    `query($q: String!, $n: Int!) { issues(first: $n, orderBy: updatedAt, filter: { or: [{ title: { containsIgnoreCase: $q } }, { description: { containsIgnoreCase: $q } }] }) { nodes { ${ISSUE_FIELDS} } } }`,
    { q: text, n: max },
  );
  return d.issues.nodes.length ? d.issues.nodes.map(issueLine).join("\n") : `Ningún issue con «${text}».`;
}

export async function teams(c: Connection): Promise<{ id: string; key: string; name: string }[]> {
  const d = await gql<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(c, "query { teams(first: 50) { nodes { id key name } } }");
  return d.teams.nodes;
}

export async function createIssue(c: Connection, a: { equipo: string; titulo: string; descripcion?: string; prioridad?: number }, at = new Date()) {
  linearLimit.check(c.id, at);
  const all = await teams(c);
  const want = a.equipo.trim().toLowerCase();
  const team = all.find((t) => t.key.toLowerCase() === want || t.name.toLowerCase() === want || t.id === a.equipo);
  if (!team) throw new Error(`No existe el equipo «${a.equipo}». Equipos: ${all.map((t) => `${t.key} (${t.name})`).join(", ")}.`);
  const input: Record<string, unknown> = { teamId: team.id, title: a.titulo.trim() };
  if (a.descripcion?.trim()) input.description = a.descripcion.trim();
  if (a.prioridad !== undefined) input.priority = a.prioridad;
  const d = await gql<{ issueCreate: { success: boolean; issue?: LIssue } }>(
    c,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
    { input },
  );
  if (!d.issueCreate.success || !d.issueCreate.issue) throw new Error("Linear no pudo crear el issue.");
  linearLimit.add(c.id, at);
  return d.issueCreate.issue;
}

export async function commentIssue(c: Connection, issue: string, body: string, at = new Date()) {
  if (!/^[A-Za-z0-9]{1,10}-\d{1,7}$/.test(issue) && !/^[0-9a-f-]{36}$/i.test(issue)) throw new Error("Issue no válido: usa su identificador (p. ej. ENG-123).");
  linearLimit.check(c.id, at);
  const d = await gql<{ commentCreate: { success: boolean } }>(c, "mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }", {
    id: issue,
    body: body.trim(),
  });
  if (!d.commentCreate.success) throw new Error("Linear no pudo comentar.");
  linearLimit.add(c.id, at);
}

function linearTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = pickGrant(grants);
  const c = g.connection;
  const audit = auditor(ctx, c, "Linear");
  const run = guard(c);
  const tools: ToolDef[] = [
    defineTool("linear_mis_issues", "Issues abiertos asignados al usuario en Linear (los más recientes primero).", { max: z.number().int().min(1).max(50).optional() }, async ({ max }) =>
      run(async () => {
        audit("lista sus issues");
        return myIssues(c, max ?? 25);
      }),
    ),
    defineTool("linear_buscar", "Busca issues de Linear por texto en el título o la descripción.", { texto: z.string().min(1).max(200), max: z.number().int().min(1).max(50).optional() }, async ({ texto, max }) =>
      run(async () => {
        audit(`busca «${texto}»`);
        return searchIssues(c, texto, max ?? 20);
      }),
    ),
    defineTool("linear_equipos", "Equipos de Linear (clave y nombre).", {}, async () =>
      run(async () => {
        audit("lista equipos");
        const t = await teams(c);
        return t.length ? t.map((x) => `- ${x.key} · ${x.name}`).join("\n") : "No hay equipos.";
      }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "linear_crear_issue",
        "Crea un issue en Linear (solo si te lo piden). Prioridad: 0 sin, 1 urgente, 2 alta, 3 media, 4 baja.",
        {
          equipo: z.string().min(1).max(60).describe("Clave o nombre del equipo"),
          titulo: z.string().min(1).max(250),
          descripcion: z.string().max(10000).optional().describe("Markdown"),
          prioridad: z.number().int().min(0).max(4).optional(),
        },
        async (a) =>
          run(async () => {
            const i = await createIssue(c, a);
            audit(`crea ${i.identifier} «${i.title}»`);
            ctx.note(`Linear: ${i.identifier} creado`, { kind: "linear" });
            return `Issue creado: ${issueLine(i)}`;
          }),
      ),
      defineTool("linear_comentar", "Comenta en un issue de Linear (p. ej. ENG-123), solo si te lo piden.", { issue: z.string().min(1).max(40), texto: z.string().min(1).max(10000) }, async ({ issue, texto }) =>
        run(async () => {
          await commentIssue(c, issue, texto);
          audit(`comenta en ${issue}`);
          ctx.note(`Linear: comentario en ${issue}`, { kind: "linear" });
          return `Comentario añadido a ${issue}.`;
        }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "linear",
  label: "Linear",
  description: "Issues de Linear: los tuyos, buscar y equipos; con permiso completo, crear issues y comentar.",
  category: "tareas",
  icon: "📐",
  levels: {
    lectura: "Lectura: tus issues, buscar y ver equipos",
    completo: `Completo: además crear issues y comentar (máx. ${linearLimit.max} al día; nunca cierra ni borra)`,
  },
  fields: [{ key: "espacio", label: "Nombre (opcional)", placeholder: "Mi empresa" }],
  supportsSecret: true,
  secretLabel: "Clave de API personal",
  secretPlaceholder: "lin_api_…",
  steps: [
    "En Linear: Settings → Account → Security & access → «Personal API keys» → «New API key».",
    "Dale permiso de lectura (y de crear issues/comentarios si algún agente debe escribir) y cópiala.",
    "Pulsa «Añadir» aquí y pega la clave en la ficha (se guarda cifrada); después «Probar conexión».",
    "Da «Lectura» o «Completo» a los agentes que lo necesiten.",
  ],
  normalizeConfig(input) {
    return { espacio: String(input.espacio ?? "").trim().slice(0, 60) || "Linear" };
  },
  defaultName(config) {
    return config.espacio === "Linear" ? "Linear" : `Linear · ${String(config.espacio)}`;
  },
  tools: linearTools,
  prompt(grants) {
    return `Linear: linear_mis_issues, linear_buscar y linear_equipos${canWrite(grants) ? "; linear_crear_issue y linear_comentar solo cuando te lo pidan" : ""}.`;
  },
  test(c) {
    return testWith(
      c,
      async () => {
        const d = await gql<{ viewer: { name: string; organization?: { name: string } } }>(c, "query { viewer { name organization { name } } }");
        return `Linear conectado como ${d.viewer.name}${d.viewer.organization ? ` (${d.viewer.organization.name})` : ""}.`;
      },
      SECRET,
    );
  },
});
