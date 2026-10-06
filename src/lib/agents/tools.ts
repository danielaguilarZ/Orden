import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { findAgentByName, getAgent, setAgentStatus } from "../repo/agents";
import { activeConversation, addMessage } from "../repo/chat";
import { getRoom } from "../repo/rooms";
import { ancestorAgentIds, createTask, getTask, FINISHED, setTaskStatus } from "../repo/tasks";
import { emit } from "../events";
import { hireAgent } from "../team";
import { PERSONALITIES } from "../personalities";
import { delegationPrompt } from "./prompt";
import type { Agent, Task } from "../types";

/**
 * Herramientas MCP propias de los agentes. Son la única forma que tienen de
 * actuar: las herramientas integradas de Claude Code están desactivadas.
 */

export interface ToolContext {
  agent: Agent;
  task: Task;
  signal: AbortSignal;
  /** Deja constancia en el chat de lo que ha hecho (línea compacta). */
  note: (text: string, data?: Record<string, unknown>) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolDef = SdkMcpToolDefinition<any>;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Igual que `tool` del SDK, pero con un tipo común para poder agruparlas. */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
): ToolDef {
  return tool(name, description, schema, handler as never) as unknown as ToolDef;
}
export type ToolFactory = (ctx: ToolContext) => ToolDef[];

const factories: ToolFactory[] = [];
/** Otros módulos (memoria, archivos…) añaden sus herramientas aquí. */
export function registerTools(factory: ToolFactory) {
  factories.push(factory);
}

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
export function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

const MAX_WAIT_MS = 25 * 60_000;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Cancelado"));
      },
      { once: true },
    );
  });
}

/** Espera a que terminen varios encargos. Expuesta para tests. */
export async function waitForTasks(ids: string[], signal: AbortSignal, timeoutMs = MAX_WAIT_MS, pollMs = 700): Promise<Task[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const tasks = ids.map((id) => getTask(id)).filter((t): t is Task => Boolean(t));
    if (tasks.every((t) => FINISHED.includes(t.status))) return tasks;
    if (Date.now() > deadline) return tasks;
    await sleep(pollMs, signal);
  }
}

function coreTools(ctx: ToolContext): ToolDef[] {
  const { agent, task } = ctx;
  const tools: ToolDef[] = [
    defineTool(
      "estado",
      "Muestra en el living qué estás haciendo ahora (bocadillo sobre tu avatar). 2-6 palabras.",
      { texto: z.string().max(80) },
      async ({ texto }) => {
        setAgentStatus(agent.id, "working", texto);
        return ok("ok");
      },
    ),
    defineTool(
      "delegar",
      "Encarga una subtarea a otro agente del equipo. No bloquea: devuelve el id del encargo. Puedes delegar varias cosas seguidas y luego recogerlas todas juntas con esperar_resultados.",
      {
        agente: z.string().describe("Nombre del agente"),
        encargo: z.string().describe("Qué tiene que hacer, concreto y autocontenido"),
        contexto: z.string().optional().describe("Datos que necesita y no sabe"),
      },
      async ({ agente, encargo, contexto }) => {
        const target = findAgentByName(agente);
        if (!target) return fail(`No hay ningún agente llamado «${agente}».`);
        if (target.id === agent.id) return fail("No puedes delegarte a ti mismo.");
        if (target.paused) return fail(`${target.name} está en pausa. Hazlo tú o pide al usuario que lo active.`);
        if (ancestorAgentIds(task.id).includes(target.id)) {
          return fail(`${target.name} ya está esperando en esta cadena de encargos; no puedes devolverle trabajo.`);
        }
        const conv = activeConversation(target.id);
        const sub = createTask({
          agentId: target.id,
          kind: "delegation",
          parentId: task.id,
          conversationId: conv.id,
          title: encargo,
          prompt: delegationPrompt(agent.name, encargo, contexto),
          createdBy: agent.id,
        });
        addMessage({
          conversationId: conv.id,
          role: "user",
          content: encargo + (contexto ? `\n\n_Contexto:_ ${contexto}` : ""),
          agentId: agent.id,
          taskId: sub.id,
          data: { fromAgentId: agent.id, fromName: agent.name },
        });
        emit("agent.visit", { fromId: agent.id, toId: target.id, text: `${target.name}, ¿te encargas de esto?` });
        ctx.note(`Encargo a ${target.name}: ${encargo}`, { kind: "delegate", taskId: sub.id, to: target.id });
        return ok(`Encargo ${sub.id} enviado a ${target.name}. Recógelo con esperar_resultados.`);
      },
    ),
    defineTool(
      "esperar_resultados",
      "Espera a que terminen los encargos delegados y devuelve sus resultados.",
      { ids: z.array(z.string()).min(1) },
      async ({ ids }) => {
        const tasks = ids.map((id) => getTask(id)).filter((t): t is Task => Boolean(t) && t!.parentId === task.id);
        if (!tasks.length) return fail("Ninguno de esos ids es un encargo tuyo.");
        const names = [...new Set(tasks.map((t) => getAgent(t.agentId)?.name ?? "?"))];
        setTaskStatus(task.id, "waiting");
        setAgentStatus(agent.id, "waiting", `Esperando a ${names.join(" y ")}`);
        try {
          const done = await waitForTasks(
            tasks.map((t) => t.id),
            ctx.signal,
          );
          const text = done
            .map((t) => {
              const who = getAgent(t.agentId)?.name ?? "?";
              if (t.status === "done") return `### ${who} — ${t.title}\n${t.result ?? "(sin respuesta)"}`;
              if (t.status === "cancelled") return `### ${who} — ${t.title}\n(Cancelado)`;
              if (t.status === "error") return `### ${who} — ${t.title}\nError: ${t.error}`;
              return `### ${who} — ${t.title}\n(Sigue en curso; no ha terminado a tiempo)`;
            })
            .join("\n\n");
          return ok(text);
        } finally {
          if (!ctx.signal.aborted) {
            setTaskStatus(task.id, "running");
            setAgentStatus(agent.id, "working", "Revisando resultados");
          }
        }
      },
    ),
  ];

  if (agent.isChief) {
    tools.push(
      defineTool(
        "crear_agente",
        "Contrata un agente nuevo para el equipo (solo si el usuario lo pide o hace falta claramente). No se le crea sala propia: se le asigna un escritorio en una sala común (la oficina compartida de la casa), donde aparece por defecto. Puede ir a cualquier sala con sala_ir.",
        {
          nombre: z.string(),
          especialidad: z.string().describe("Ámbito del que se encarga"),
          instrucciones: z.string().optional(),
          modelo: z.enum(["haiku", "sonnet", "opus"]).optional().describe("haiku para tareas sencillas (por defecto), sonnet para complejas"),
          personalidad: z.enum(PERSONALITIES.map((p) => p.key) as [string, ...string[]]).optional(),
        },
        async ({ nombre, especialidad, instrucciones, modelo, personalidad }) => {
          try {
            const a = hireAgent(
              {
                name: nombre,
                specialty: especialidad,
                instructions: instrucciones ?? "",
                model: modelo ?? "haiku",
                personality: { preset: personalidad ?? "meticuloso", description: "", voice: "" },
              },
              agent.id,
            );
            ctx.note(`Ha contratado a ${a.name} (${a.specialty})`, { kind: "hire", agentId: a.id });
            const desk = a.roomId ? getRoom(a.roomId) : null;
            return ok(`${a.name} se ha unido al equipo${desk ? `; tiene su escritorio en «${desk.name}»` : ""}.`);
          } catch (err) {
            return fail((err as Error).message);
          }
        },
      ),
    );
  }
  return tools;
}

registerTools(coreTools);

export function buildTools(ctx: ToolContext): ToolDef[] {
  return factories.flatMap((f) => f(ctx));
}
