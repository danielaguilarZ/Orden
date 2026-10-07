import { z } from "zod";
import { defineTool, fail, ok, registerTools, type ToolContext } from "../agents/tools";
import { registerPromptSection } from "../agents/prompt";
import { findAgentByName, getAgent, listAgents } from "../repo/agents";
import type { Agent } from "../types";
import { addItem, createUnit, findItem, findUnitByName, getRole, getUnit, listBacklog, listUnits, setRole, updateItem, updateUnit } from "./repo";
import { UNIT_KINDS, UNIT_KIND_LABEL, type BacklogItem } from "./types";

/** Herramientas y prompt de la organización: puesto, organigrama y cartera. */

const PRIORITY = { alta: 1, media: 2, baja: 3 } as const;
const PRIORITY_NAME = { 1: "alta", 2: "media", 3: "baja" } as const;

const fmtItem = (i: BacklogItem) =>
  `${i.id.slice(0, 8)} · [${i.status}${i.status === "pendiente" ? ` · ${PRIORITY_NAME[i.priority]}` : ""}] ${i.title}${i.unitId ? ` · ${getUnit(i.unitId)?.name ?? ""}` : ""}${i.model ? ` · ${i.model}` : ""}`;

/** Puede repartir trabajo a `target`: el jefe a cualquiera; quien dirige una unidad, a su equipo. */
function canAssign(from: Agent, target: Agent): boolean {
  if (from.id === target.id || from.isChief) return true;
  const mine = getRole(from.id);
  return mine.lead && mine.unitId !== null && getRole(target.id).unitId === mine.unitId;
}

// ───────────────────────── Prompt ─────────────────────────

registerPromptSection((agent) => {
  const role = getRole(agent.id);
  const unit = role.unitId ? getUnit(role.unitId) : null;
  if (!role.role && !role.duties && !unit) return null;
  return [
    `Tu puesto: ${role.role || "miembro del equipo"}${unit ? ` en ${unit.name} (${UNIT_KIND_LABEL[unit.kind]})` : ""}${role.lead ? ". Diriges esta unidad: repartes y revisas el trabajo de tu equipo" : ""}.`,
    role.duties ? `Tus funciones:\n${role.duties}` : "",
    `Trabajas como en una empresa real: además de los encargos, tienes una cartera de trabajo propio (herramientas cartera_*). Cuando nadie te pide nada, el piloto automático te da la siguiente tarea de tu cartera o te pide que la planifiques. Cierra cada tarea con cartera_completar o cartera_descartar.`,
  ]
    .filter(Boolean)
    .join("\n");
});

registerPromptSection(
  (agent) => {
    const units = listUnits();
    if (!units.length) return null;
    const agents = listAgents();
    const lines = units.map((u) => {
      const members = agents
        .filter((a) => getRole(a.id).unitId === u.id)
        .map((a) => {
          const r = getRole(a.id);
          return `${a.name}${r.role ? ` (${r.role}${r.lead ? ", dirige" : ""})` : ""}`;
        });
      return `- ${u.name} · ${UNIT_KIND_LABEL[u.kind]}: ${u.summary.slice(0, 220) || "sin descripción"}${u.goals ? `\n  Objetivos: ${u.goals.slice(0, 220)}` : ""}${members.length ? `\n  Equipo: ${members.join(", ")}` : ""}`;
    });
    const mine = listBacklog({ agentId: agent.id, statuses: ["en_curso", "pendiente"], limit: 6 });
    return [`Organización (unidades y quién trabaja en cada una):\n${lines.join("\n")}`, mine.length ? `Tu cartera:\n${mine.map(fmtItem).join("\n")}` : ""]
      .filter(Boolean)
      .join("\n\n");
  },
  { dynamic: true },
);

// ───────────────────────── Herramientas ─────────────────────────

registerTools((ctx: ToolContext) => {
  const me = ctx.agent;
  const tools = [
    defineTool("organizacion", "Unidades de la organización (empresas, departamentos, dirección) con su descripción, objetivos y equipo.", {}, async () => {
      const units = listUnits();
      if (!units.length) return ok("Aún no hay unidades definidas.");
      return ok(
        units
          .map((u) => {
            const team = listAgents()
              .filter((a) => getRole(a.id).unitId === u.id)
              .map((a) => `${a.name} (${getRole(a.id).role || "sin cargo"})`);
            return `## ${u.name} · ${UNIT_KIND_LABEL[u.kind]}\n${u.summary}\nObjetivos: ${u.goals || "—"}\nEquipo: ${team.join(", ") || "nadie"}`;
          })
          .join("\n\n"),
      );
    }),
    defineTool("cartera", "Tu cartera de trabajo: tareas pendientes, en curso y las últimas hechas.", {}, async () => {
      const items = listBacklog({ agentId: me.id, limit: 25 });
      return ok(items.length ? items.map((i) => `${fmtItem(i)}${i.result ? `\n    ↳ ${i.result.slice(0, 160)}` : ""}`).join("\n") : "Tu cartera está vacía.");
    }),
    defineTool(
      "cartera_equipo",
      "Carteras de tu equipo (si diriges una unidad) o de todos (si eres el jefe): qué tiene pendiente cada uno.",
      {},
      async () => {
        const team = listAgents().filter((a) => a.id !== me.id && canAssign(me, a));
        if (!team.length) return fail("No diriges ningún equipo.");
        return ok(
          team
            .map((a) => {
              const items = listBacklog({ agentId: a.id, statuses: ["en_curso", "pendiente"], limit: 6 });
              return `## ${a.name} (${getRole(a.id).role || "sin cargo"})\n${items.map(fmtItem).join("\n") || "Sin tareas pendientes."}`;
            })
            .join("\n\n"),
        );
      },
    ),
    defineTool(
      "cartera_nueva",
      "Añade una tarea concreta y útil a tu cartera (o a la de alguien de tu equipo si diriges la unidad; el jefe, a cualquiera).",
      {
        titulo: z.string().min(3).max(140),
        detalle: z.string().max(4000).describe("Qué hay que hacer, con qué datos y qué entregable se espera"),
        prioridad: z.enum(["alta", "media", "baja"]).default("media"),
        modelo: z.enum(["haiku", "sonnet", "opus"]).optional().describe("haiku: mecánico; sonnet: normal; opus: estratégico o muy complejo"),
        unidad: z.string().optional().describe("Empresa o unidad para la que es"),
        agente: z.string().optional().describe("Para quién (por defecto, tú)"),
      },
      async ({ titulo, detalle, prioridad, modelo, unidad, agente }) => {
        const target = agente ? findAgentByName(agente) : me;
        if (!target) return fail(`No hay ningún agente llamado «${agente}».`);
        if (!canAssign(me, target)) return fail(`No puedes asignar trabajo a ${target.name}: no es de tu equipo.`);
        const unit = unidad ? findUnitByName(unidad) : null;
        if (unidad && !unit) return fail(`No existe la unidad «${unidad}».`);
        try {
          const item = addItem({
            agentId: target.id,
            title: titulo,
            detail: detalle,
            priority: PRIORITY[prioridad],
            model: modelo ?? null,
            unitId: unit?.id ?? getRole(target.id).unitId,
            source: target.id === me.id ? "agente" : "jefe",
            createdBy: me.id,
          });
          ctx.note(`Añade a la cartera de ${target.name}: ${item.title}`, { kind: "backlog", itemId: item.id });
          return ok(`Añadida (${item.id.slice(0, 8)}).`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
    defineTool(
      "cartera_completar",
      "Cierra una tarea de tu cartera como hecha, con un resumen breve de lo conseguido y dónde quedó.",
      { id: z.string(), resumen: z.string().max(1500) },
      async ({ id, resumen }) => {
        const item = findItem(id);
        if (!item || !canAssign(me, getAgent(item.agentId)!)) return fail("No encuentro esa tarea en tu cartera.");
        updateItem(item.id, { status: "hecha", result: resumen });
        return ok("Hecha.");
      },
    ),
    defineTool(
      "cartera_descartar",
      "Descarta una tarea que ya no tiene sentido (o que no se puede hacer), con el motivo.",
      { id: z.string(), motivo: z.string().max(800) },
      async ({ id, motivo }) => {
        const item = findItem(id);
        if (!item || !canAssign(me, getAgent(item.agentId)!)) return fail("No encuentro esa tarea en tu cartera.");
        updateItem(item.id, { status: "descartada", result: motivo });
        return ok("Descartada.");
      },
    ),
  ];

  if (me.isChief) {
    tools.push(
      defineTool(
        "unidad_guardar",
        "Crea o edita una unidad de la organización (empresa, departamento, dirección o lo personal).",
        {
          nombre: z.string().min(2).max(60),
          tipo: z.enum(UNIT_KINDS as [string, ...string[]]).optional(),
          descripcion: z.string().max(2000).optional(),
          objetivos: z.string().max(2000).optional(),
        },
        async ({ nombre, tipo, descripcion, objetivos }) => {
          const cur = findUnitByName(nombre);
          const patch = {
            ...(tipo && { kind: tipo as (typeof UNIT_KINDS)[number] }),
            ...(descripcion !== undefined && { summary: descripcion }),
            ...(objetivos !== undefined && { goals: objetivos }),
          };
          const unit = cur ? updateUnit(cur.id, patch) : createUnit({ name: nombre, kind: patch.kind ?? "empresa", ...patch });
          ctx.note(`${cur ? "Actualiza" : "Crea"} la unidad ${unit.name}`, { kind: "unit", unitId: unit.id });
          return ok(`Guardada: ${unit.name}.`);
        },
      ),
      defineTool(
        "puesto_asignar",
        "Define el puesto de un agente: unidad, cargo, funciones y si dirige la unidad.",
        {
          agente: z.string(),
          unidad: z.string().optional(),
          cargo: z.string().max(80).optional(),
          funciones: z.string().max(2000).optional(),
          dirige: z.boolean().optional(),
        },
        async ({ agente, unidad, cargo, funciones, dirige }) => {
          const target = findAgentByName(agente);
          if (!target) return fail(`No hay ningún agente llamado «${agente}».`);
          const unit = unidad ? findUnitByName(unidad) : null;
          if (unidad && !unit) return fail(`No existe la unidad «${unidad}».`);
          setRole(target.id, {
            ...(unit && { unitId: unit.id }),
            ...(cargo !== undefined && { role: cargo }),
            ...(funciones !== undefined && { duties: funciones }),
            ...(dirige !== undefined && { lead: dirige }),
          });
          ctx.note(`Define el puesto de ${target.name}${cargo ? `: ${cargo}` : ""}`, { kind: "role", agentId: target.id });
          return ok("Puesto guardado.");
        },
      ),
    );
  }
  return tools;
});
