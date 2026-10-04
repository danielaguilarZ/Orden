import { z } from "zod";
import { defineTool, fail, ok, registerTools, type ToolDef, type ToolContext } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import {
  advanceProposal,
  authorOf,
  createProposal,
  findProposal,
  isPostponed,
  LEVELS,
  listProposals,
  PRIORITIES,
  PROPOSAL_STATUSES,
  SCOPE_KEYS,
  SCOPES,
  STATUS_LABEL,
  type Proposal,
  type ProposalScope,
  type ProposalStatus,
} from "./repo";

/**
 * Herramientas de Propuestas. Todos pueden leerlas; solo el jefe (Zen) crea
 * y hace avanzar (en curso / hecha). Aceptar, rechazar o aplazar es cosa del
 * usuario, desde la pestaña.
 */

const MAX_LIST = 60;

function line(p: Proposal, full = false): string {
  const postponed = isPostponed(p) ? ` · aplazada hasta ${p.postponedUntil!.slice(0, 10)}` : "";
  const head = `- [${p.id.slice(0, 8)}] «${p.title}» · ${STATUS_LABEL[p.status].toLowerCase()}${postponed} · ${SCOPES[p.scope]} · prioridad ${p.priority} · impacto ${p.impact} · esfuerzo ${p.effort} · ${authorOf(p)} · ${p.createdAt.slice(0, 10)}`;
  const extra: string[] = [];
  if (full && p.description) extra.push(`  ${p.description.replace(/\n+/g, " ").slice(0, 300)}`);
  if (p.rejectReason) extra.push(`  Motivo del rechazo: ${p.rejectReason}`);
  if (p.resultNote) extra.push(`  Resultado: ${p.resultNote.replace(/\n+/g, " ").slice(0, 300)}`);
  return [head, ...extra].join("\n");
}

/** Texto de propuestas_listar. Expuesta para tests. */
export function listForAgent(estado?: ProposalStatus | "todas", ambito?: ProposalScope): string {
  let list = listProposals({ statuses: estado && estado !== "todas" ? [estado] : undefined });
  if (ambito) list = list.filter((p) => p.scope === ambito);
  if (!list.length) return "No hay propuestas con ese filtro.";
  const shown = list.slice(0, MAX_LIST);
  return `${list.length} propuesta${list.length === 1 ? "" : "s"}:\n${shown.map((p) => line(p, true)).join("\n")}${list.length > MAX_LIST ? `\n… (y ${list.length - MAX_LIST} más)` : ""}`;
}

function readTools(): ToolDef[] {
  return [
    defineTool(
      "propuestas_listar",
      "Lista las propuestas de la pestaña «Acción humana» (las decide el usuario: aceptar, rechazar o aplazar). Filtra por estado y ámbito. Las rechazadas traen su motivo.",
      {
        estado: z.enum([...PROPOSAL_STATUSES, "todas"]).optional().describe("Por defecto, todas"),
        ambito: z.enum(SCOPE_KEYS).optional(),
      },
      async ({ estado, ambito }) => ok(listForAgent(estado, ambito)),
    ),
  ];
}

function chiefTools(ctx: ToolContext): ToolDef[] {
  const { agent } = ctx;
  return [
    defineTool(
      "propuesta_crear",
      "Crea una propuesta para que el usuario la acepte o rechace en la pestaña «Acción humana». No ejecutes nada hasta que la acepte. Si se parece a una rechazada (o a una abierta) se niega y te dice el motivo.",
      {
        titulo: z.string().min(3).max(140),
        descripcion: z.string().max(4000).describe("Markdown corto: qué, por qué y cómo (3-6 líneas)"),
        ambito: z.enum(SCOPE_KEYS).describe(Object.entries(SCOPES).map(([k, v]) => `${k} = ${v}`).join(", ")),
        prioridad: z.enum(PRIORITIES),
        impacto: z.enum(LEVELS),
        esfuerzo: z.enum(LEVELS),
      },
      async ({ titulo, descripcion, ambito, prioridad, impacto, esfuerzo }) => {
        try {
          const p = createProposal({ title: titulo, description: descripcion, scope: ambito, priority: prioridad, impact: impacto, effort: esfuerzo }, agent);
          ctx.note(`Ha propuesto «${p.title}»`, { kind: "proposal", proposalId: p.id });
          return ok(`Propuesta creada (id ${p.id.slice(0, 8)}), pendiente de que el usuario decida.`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
    defineTool(
      "propuesta_actualizar",
      "Marca una propuesta ACEPTADA como «en_curso» al empezar a ejecutarla o «hecha» al terminar, con una nota de resultado (qué se hizo y dónde verlo).",
      {
        id: z.string().describe("Id (vale el corto de 8 caracteres)"),
        estado: z.enum(["en_curso", "hecha"]),
        nota: z.string().max(4000).optional().describe("Resultado o avance"),
      },
      async ({ id, estado, nota }) => {
        const p = findProposal(id);
        if (!p) return fail(`No encuentro la propuesta «${id}». Míralas con propuestas_listar.`);
        try {
          const next = advanceProposal(p.id, estado, nota, agent);
          ctx.note(`Propuesta «${next.title}» → ${STATUS_LABEL[next.status].toLowerCase()}`, { kind: "proposal", proposalId: next.id });
          return ok(`Hecho: «${next.title}» está ${STATUS_LABEL[next.status].toLowerCase()}.`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
  ];
}

registerTools((ctx) => {
  if (ctx.task.kind === "ambient") return [];
  return ctx.agent.isChief ? [...readTools(), ...chiefTools(ctx)] : readTools();
});

registerPromptSection((agent) => {
  if (!agent.isChief) return null;
  return `Propuestas (pestaña «Acción humana» de la app): tus ideas de mejora van ahí con propuesta_crear (título, descripción corta, ámbito, prioridad, impacto y esfuerzo); el usuario las acepta, rechaza (con motivo opcional) o aplaza.
- En esa misma pestaña el usuario ve, arriba, el panel de lista «Acción humana · lo que necesito de ti»: mantenlo al día con lo que necesitas de él (PDFs, logins, conexiones).
- Solo ejecutas una propuesta cuando está ACEPTADA: entonces tienes permisos completos (salvo borrar datos). Te llega un encargo; márcala «en_curso» y, al acabar, «hecha» con una nota de resultado (propuesta_actualizar).
- No repitas lo rechazado: su motivo es aprendizaje para proponer mejor.`;
});

const MAX_REJECTED = 10;

/** Resumen para el contexto de Zen: lo aceptado por ejecutar y lo rechazado reciente. Expuesto para tests. */
export function chiefProposalsContext(): string | null {
  const open = listProposals({ statuses: ["pendiente", "aceptada", "en_curso"] });
  const rejected = listProposals({ statuses: ["rechazada"], limit: MAX_REJECTED });
  if (!open.length && !rejected.length) return null;
  const pending = open.filter((p) => p.status === "pendiente" && !isPostponed(p)).length;
  const postponed = open.filter((p) => isPostponed(p)).length;
  const todo = open.filter((p) => p.status === "aceptada" || p.status === "en_curso");
  const parts = [`Propuestas: ${pending} pendiente${pending === 1 ? "" : "s"} de decidir${postponed ? `, ${postponed} aplazada${postponed === 1 ? "" : "s"}` : ""}.`];
  if (todo.length) parts.push(`Aceptadas por ejecutar:\n${todo.map((p) => line(p)).join("\n")}`);
  if (rejected.length) parts.push(`Rechazadas recientes (no las repitas):\n${rejected.map((p) => `- «${p.title}»${p.rejectReason ? ` · motivo: ${p.rejectReason}` : ""}`).join("\n")}`);
  return parts.join("\n");
}

registerPromptSection((agent) => (agent.isChief ? chiefProposalsContext() : null), { dynamic: true });
