import { z } from "zod";
import { defineTool, fail, ok, registerTools, type ToolDef, type ToolContext } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import type { Agent } from "../types";
import {
  answerLabel,
  authorOf,
  createDecision,
  DECISION_STATUSES,
  findDecision,
  isPostponed,
  listDecisions,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  TAB_LABEL,
  withdrawDecision,
  type Decision,
  type DecisionStatus,
} from "./repo";

/**
 * Herramientas de Decisiones. Cualquier agente puede plantear una decisión al
 * usuario, listarlas y retirar las suyas. Responder es cosa del usuario, desde
 * la pestaña; su respuesta le llega al agente como mensaje en su chat.
 */

const MAX_LIST = 60;

function line(d: Decision, full = false): string {
  const postponed = isPostponed(d) ? ` · aplazada hasta ${d.postponedUntil!.slice(0, 10)}` : "";
  const kind = d.approval ? "sí/no" : d.options.length ? `opciones: ${d.options.join(" | ")}` : "respuesta libre";
  const head = `- [${d.id.slice(0, 8)}] «${d.title}» · ${d.status}${postponed} · ${kind} · ${authorOf(d)} · ${d.createdAt.slice(0, 10)}`;
  const extra: string[] = [];
  if (full && d.context) extra.push(`  ${d.context.replace(/\n+/g, " ").slice(0, 300)}`);
  if (d.status === "resuelta") extra.push(`  ${answerLabel(d)}`);
  return [head, ...extra].join("\n");
}

/** Texto de decisiones_listar. Expuesta para tests. */
export function listForAgent(estado?: DecisionStatus | "todas", authorId?: string): string {
  const list = listDecisions({ statuses: estado && estado !== "todas" ? [estado] : undefined, authorId });
  if (!list.length) return "No hay decisiones con ese filtro.";
  const shown = list.slice(0, MAX_LIST);
  return `${list.length} decisi${list.length === 1 ? "ón" : "ones"}:\n${shown.map((d) => line(d, true)).join("\n")}${list.length > MAX_LIST ? `\n… (y ${list.length - MAX_LIST} más)` : ""}`;
}

function decisionTools(ctx: ToolContext): ToolDef[] {
  const { agent } = ctx;
  return [
    defineTool(
      "decision_crear",
      `Plantea al usuario una decisión en la pestaña «${TAB_LABEL}»: aprobar una idea (aprobar=true), elegir entre opciones o responder con texto (un dato, un login, un archivo). Su respuesta te llegará como mensaje; no hagas nada que dependa de ella hasta entonces. Si se parece a algo rechazado (o ya pendiente) se niega y te dice el motivo.`,
      {
        titulo: z.string().min(3).max(140).describe("Pregunta o propuesta, clara y corta"),
        contexto: z.string().max(4000).describe("Markdown breve (2-5 líneas): por qué lo preguntas y qué harás después"),
        opciones: z.array(z.string().min(1).max(MAX_OPTION_LENGTH)).max(MAX_OPTIONS).optional().describe("Respuestas sugeridas (botones rápidos)"),
        aprobar: z.boolean().optional().describe("true si es un sí/no: muestra «Aceptar» y «Rechazar»"),
      },
      async ({ titulo, contexto, opciones, aprobar }) => {
        try {
          const d = createDecision({ title: titulo, context: contexto, options: opciones, approval: aprobar }, agent);
          ctx.note(`Ha planteado la decisión «${d.title}»`, { kind: "decision", decisionId: d.id });
          return ok(`Decisión creada (id ${d.id.slice(0, 8)}), pendiente de que el usuario responda. Te llegará su respuesta como mensaje.`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
    defineTool(
      "decisiones_listar",
      `Lista las decisiones de la pestaña «${TAB_LABEL}» (pendientes y resueltas, con la respuesta del usuario). Las rechazadas traen su motivo: no las repitas.`,
      {
        estado: z.enum([...DECISION_STATUSES, "todas"]).optional().describe("Por defecto, todas"),
        solo_mias: z.boolean().optional().describe("Solo las que planteaste tú"),
      },
      async ({ estado, solo_mias }) => ok(listForAgent(estado, solo_mias ? agent.id : undefined)),
    ),
    defineTool(
      "decision_retirar",
      "Retira una decisión pendiente que ya no hace falta (solo las tuyas; el jefe, cualquiera). No se avisa al usuario.",
      { id: z.string().describe("Id (vale el corto de 8 caracteres)") },
      async ({ id }) => {
        const d = findDecision(id);
        if (!d) return fail(`No encuentro la decisión «${id}». Míralas con decisiones_listar.`);
        try {
          const next = withdrawDecision(d.id, agent);
          ctx.note(`Ha retirado la decisión «${next.title}»`, { kind: "decision", decisionId: next.id });
          return ok(`Retirada: «${next.title}».`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
  ];
}

registerTools((ctx) => (ctx.task.kind === "ambient" ? [] : decisionTools(ctx)));

registerPromptSection(
  (agent) => `Decisiones (pestaña «${TAB_LABEL}» de la app): cuando necesites que el usuario decida o te dé algo (aprobar una idea, elegir entre opciones, un dato, un login, un archivo), plantéalo con decision_crear: título claro, contexto breve, opciones sugeridas si las hay y aprobar=true si es un sí/no. Su respuesta te llega como mensaje en tu chat; hasta entonces, no hagas nada que dependa de ella.
- No repitas lo rechazado: su motivo es aprendizaje.${agent.isChief ? "\n- Como jefe, tus ideas de mejora también van como decisión de sí/no; cuando el usuario acepta, te llega el encargo de ejecutarla." : ""}
- Antes se llamaban «propuestas»: propuesta_crear → decision_crear y propuestas_listar → decisiones_listar.`,
);

const MAX_REJECTED = 10;

/**
 * Resumen para el contexto: pendientes del agente (todas, si es el jefe) y lo
 * rechazado reciente. Expuesto para tests.
 */
export function decisionsContext(agent: Agent): string | null {
  const mine = (d: Decision) => agent.isChief || d.authorId === agent.id;
  const pending = listDecisions({ statuses: ["pendiente"] }).filter(mine);
  const rejected = listDecisions({ statuses: ["resuelta"], limit: 200 })
    .filter((d) => d.answerKind === "rechazar" && mine(d))
    .slice(0, MAX_REJECTED);
  if (!pending.length && !rejected.length) return null;
  const postponed = pending.filter((d) => isPostponed(d)).length;
  const who = agent.isChief ? "del equipo" : "tuyas";
  const parts = [
    `Decisiones ${who}: ${pending.length - postponed} pendiente${pending.length - postponed === 1 ? "" : "s"} de respuesta${postponed ? `, ${postponed} aplazada${postponed === 1 ? "" : "s"}` : ""}.`,
  ];
  if (pending.length) parts.push(pending.slice(0, 15).map((d) => line(d)).join("\n"));
  if (rejected.length) parts.push(`Rechazadas recientes (no las repitas):\n${rejected.map((d) => `- «${d.title}»${d.answer ? ` · motivo: ${d.answer}` : ""}`).join("\n")}`);
  return parts.join("\n");
}

registerPromptSection((agent) => decisionsContext(agent), { dynamic: true });
