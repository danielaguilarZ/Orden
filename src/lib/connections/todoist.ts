import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson, fetchText } from "./http";
import { auditor, canWrite, DailyLimit, guard, pickGrant, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Todoist con un token personal. Lectura: tareas (con los filtros de
 * Todoist) y proyectos. Completo: además crear y completar tareas (máx. 50
 * cambios al día). Nunca borra.
 */

const API = "https://api.todoist.com/api/v1";
const SECRET = "token de Todoist";
export const todoistLimit = new DailyLimit(50, "cambios en Todoist");

export interface TTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  priority?: number;
  labels?: string[];
  due?: { date?: string; datetime?: string | null; string?: string; is_recurring?: boolean } | null;
}
interface TProject {
  id: string;
  name: string;
}
type Page<T> = T[] | { results?: T[]; next_cursor?: string | null };
const rows = <T>(p: Page<T>): T[] => (Array.isArray(p) ? p : (p.results ?? []));

function api<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return fetchJson<T>(
    `${API}${path}`,
    { method: init.method ?? "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    { secrets: [token] },
  );
}

/** Prioridad de Todoist (4 = urgente) → «p1»…«p4» como en la app. */
export const prioLabel = (p?: number) => `p${5 - Math.min(4, Math.max(1, p ?? 1))}`;

/** Una tarea en una línea. */
export function taskLine(t: TTask, projects: Map<string, string>): string {
  const due = t.due?.datetime ? t.due.datetime.slice(0, 16).replace("T", " ") : t.due?.date;
  const bits = [
    due ? `vence ${due}${t.due?.is_recurring ? " (recurrente)" : ""}` : null,
    t.priority && t.priority > 1 ? prioLabel(t.priority) : null,
    t.project_id && projects.get(t.project_id) ? `#${projects.get(t.project_id)}` : null,
    t.labels?.length ? t.labels.map((l) => `@${l}`).join(" ") : null,
  ].filter(Boolean);
  return `- ${t.content}${bits.length ? ` · ${bits.join(" · ")}` : ""} · id ${t.id}`;
}

async function projectMap(token: string): Promise<Map<string, string>> {
  return new Map(rows(await api<Page<TProject>>(token, "/projects?limit=200")).map((p) => [p.id, p.name]));
}

export async function listTasks(c: Connection, filter = "today | overdue", max = 30): Promise<string> {
  const token = requireSecret(c, SECRET);
  const q = new URLSearchParams({ query: filter, limit: String(Math.min(100, Math.max(1, max))) });
  const [tasks, projects] = await Promise.all([api<Page<TTask>>(token, `/tasks/filter?${q}`), projectMap(token)]);
  const list = rows(tasks).slice(0, max);
  if (!list.length) return `No hay tareas con el filtro «${filter}».`;
  return [`${list.length} tarea(s) con «${filter}»:`, ...list.map((t) => taskLine(t, projects))].join("\n");
}

export async function listProjects(c: Connection): Promise<string> {
  const token = requireSecret(c, SECRET);
  const map = await projectMap(token);
  return map.size ? [...map].map(([id, name]) => `- ${name} · id ${id}`).join("\n") : "No hay proyectos.";
}

export interface NewTask {
  texto: string;
  cuando?: string;
  proyecto?: string;
  prioridad?: number;
  descripcion?: string;
}

export async function addTodoistTask(c: Connection, t: NewTask, at = new Date()): Promise<TTask> {
  const token = requireSecret(c, SECRET);
  todoistLimit.check(c.id, at);
  const body: Record<string, unknown> = { content: t.texto.trim() };
  if (t.descripcion?.trim()) body.description = t.descripcion.trim();
  if (t.cuando?.trim()) {
    body.due_string = t.cuando.trim();
    body.due_lang = "es";
  }
  if (t.prioridad) body.priority = 5 - t.prioridad;
  if (t.proyecto?.trim()) {
    const wanted = t.proyecto.trim().toLowerCase();
    const found = [...(await projectMap(token))].find(([id, name]) => id === t.proyecto || name.toLowerCase() === wanted);
    if (!found) throw new Error(`No existe el proyecto «${t.proyecto}» en Todoist.`);
    body.project_id = found[0];
  }
  const task = await api<TTask>(token, "/tasks", { method: "POST", body });
  todoistLimit.add(c.id, at);
  return task;
}

export async function closeTask(c: Connection, id: string, at = new Date()): Promise<void> {
  const token = requireSecret(c, SECRET);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error("Id de tarea no válido.");
  todoistLimit.check(c.id, at);
  await fetchText(`${API}/tasks/${id}/close`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, { secrets: [token] });
  todoistLimit.add(c.id, at);
}

function todoistTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = pickGrant(grants);
  const c = g.connection;
  const audit = auditor(ctx, c, "Todoist");
  const run = guard(c);
  const tools: ToolDef[] = [
    defineTool(
      "todoist_tareas",
      "Tareas pendientes de Todoist. El filtro usa la sintaxis de Todoist: «today | overdue» (por defecto), «tomorrow», «7 days», «#Proyecto», «@etiqueta», «p1»…",
      { filtro: z.string().max(200).optional(), max: z.number().int().min(1).max(100).optional() },
      async ({ filtro, max }) =>
        run(async () => {
          audit(`lista tareas${filtro ? ` («${filtro}»)` : ""}`);
          return listTasks(c, filtro?.trim() || "today | overdue", max ?? 30);
        }),
    ),
    defineTool("todoist_proyectos", "Proyectos de Todoist (nombre e id).", {}, async () =>
      run(async () => {
        audit("lista proyectos");
        return listProjects(c);
      }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "todoist_crear",
        "Crea una tarea en Todoist (solo si te lo piden). «cuando» en lenguaje natural («mañana a las 10», «cada lunes»); prioridad 1 = urgente … 4 = normal.",
        {
          texto: z.string().min(1).max(500),
          cuando: z.string().max(100).optional(),
          proyecto: z.string().max(120).optional().describe("Nombre o id del proyecto (por defecto, Bandeja de entrada)"),
          prioridad: z.number().int().min(1).max(4).optional(),
          descripcion: z.string().max(2000).optional(),
        },
        async (args) =>
          run(async () => {
            const t = await addTodoistTask(c, args);
            audit(`crea la tarea «${t.content}»`);
            ctx.note(`Todoist: tarea «${t.content}»`, { kind: "todoist" });
            return `Tarea creada: ${taskLine(t, new Map())}`;
          }),
      ),
      defineTool("todoist_completar", "Marca como hecha una tarea de Todoist por su id (solo si te lo piden).", { id: z.string().min(1).max(40) }, async ({ id }) =>
        run(async () => {
          await closeTask(c, id);
          audit(`completa la tarea ${id}`);
          ctx.note(`Todoist: tarea ${id} completada`, { kind: "todoist" });
          return `Tarea ${id} completada.`;
        }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "todoist",
  label: "Todoist",
  description: "Tus tareas de Todoist: ver las de hoy, las vencidas o cualquier filtro; con permiso completo, crear y completar tareas.",
  category: "tareas",
  levels: {
    lectura: "Lectura: ver tareas (con filtros) y proyectos",
    completo: `Completo: además crear y completar tareas (máx. ${todoistLimit.max} cambios al día; nunca borra)`,
  },
  fields: [{ key: "cuenta", label: "Nombre (opcional)", placeholder: "Personal" }],
  supportsSecret: true,
  secretLabel: "Token de API",
  secretPlaceholder: "0123456789abcdef…",
  steps: [
    "En Todoist (web): Ajustes → Integraciones → Desarrollador → copia tu «Token de API».",
    "Pulsa «Añadir» aquí y pega el token en la ficha (se guarda cifrado).",
    "Pulsa «Probar conexión»: verás cuántos proyectos tienes.",
    "Da «Lectura» para que vean tus tareas o «Completo» para que también las creen y completen.",
  ],
  normalizeConfig(input) {
    return { cuenta: String(input.cuenta ?? "").trim().slice(0, 60) || "Todoist" };
  },
  defaultName(config) {
    return config.cuenta === "Todoist" ? "Todoist" : `Todoist · ${String(config.cuenta)}`;
  },
  tools: todoistTools,
  prompt(grants) {
    return `Todoist: todoist_tareas (filtros de Todoist, p. ej. «today | overdue») y todoist_proyectos${canWrite(grants) ? "; todoist_crear y todoist_completar solo cuando te lo pidan" : ""}.`;
  },
  test(c) {
    return testWith(
      c,
      async (token) => {
        const n = rows(await api<Page<TProject>>(token!, "/projects?limit=200")).length;
        return `Todoist conectado: ${n} proyecto(s).`;
      },
      SECRET,
    );
  },
});
