import { getDb } from "../db";
import { getStoredUsage } from "../claude/usage";
import { listAgents } from "../repo/agents";
import { createTask, getTask } from "../repo/tasks";
import { logActivity } from "../repo/system";
import type { Agent, ModelChoice, Task } from "../types";
import { getAutopilotSettings, judgeBudget, type BudgetVerdict } from "./budget";
import { getRole, getUnit, listBacklog, listRoles, setRole, updateItem } from "./repo";
import type { AgentRole, BacklogItem } from "./types";

/**
 * Piloto automático: mientras el regulador lo permita, nadie con puesto se
 * queda parado. Por orden: primero los encargos del usuario (si hay alguno en
 * cola, espera), luego la cartera de cada agente y, si está vacía, que el
 * agente planifique su siguiente trabajo. Lo llama el worker cada pocos segundos.
 */

const HOUR = 3600_000;
/** Tras planificar, no vuelve a hacerlo antes de esto (y más si no se le ocurrió nada útil). */
const PLAN_PAUSE_MS = 2 * HOUR;
const PLAN_BACKOFF_MS = 8 * HOUR;
/** Intentos de una tarea de la cartera antes de darla por bloqueada. */
const MAX_ATTEMPTS = 2;

const PRIORITY_LABEL = { 1: "alta", 2: "media", 3: "baja" } as const;

export function itemPrompt(item: BacklogItem, agentRole: AgentRole): string {
  const unit = item.unitId ? getUnit(item.unitId) : null;
  return `Trabajo de tu cartera (es iniciativa tuya: nadie espera en el chat).
«${item.title}» · id ${item.id.slice(0, 8)} · prioridad ${PRIORITY_LABEL[item.priority]}${unit ? ` · para ${unit.name}` : ""}
${item.detail}

- Hazlo de verdad con lo que tienes: memoria, archivos, paneles y conexiones. No inventes cifras, nombres ni hechos; si falta información, dilo y propón cómo conseguirla (o plantéasela al usuario con una decisión).
- Deja el resultado donde sirva: un archivo con archivo_escribir, un panel o la memoria. Una respuesta suelta se pierde.
- Al terminar, cierra la tarea con cartera_completar (id ${item.id.slice(0, 8)}) y un resumen de 1-3 líneas. Si ya no tiene sentido, usa cartera_descartar con el motivo.
- Si descubres trabajo nuevo que merezca la pena, añádelo con cartera_nueva${agentRole.lead ? " (a ti o a tu equipo)" : ""}.`;
}

export function planningPrompt(agent: Agent, agentRole: AgentRole): string {
  const chief = agent.isChief
    ? "\n- Como jefe, mira también cómo va cada unidad con «organizacion» y «cartera_equipo», y reparte trabajo (cartera_nueva con agente) a quien esté sin tareas o a las unidades que vayan flojas."
    : agentRole.lead
      ? "\n- Diriges tu unidad: revisa con «cartera_equipo» a tu equipo y reparte trabajo a quien esté sin tareas."
      : "";
  return `Planificación de tu puesto (nadie te ha pedido nada: es tu iniciativa).
Tu cartera no tiene trabajo pendiente. Repasa tu puesto, tus funciones, los objetivos de tu unidad y de las empresas a las que das servicio, la memoria y lo último que se ha hecho.
- Añade con cartera_nueva de 1 a 4 tareas concretas y útiles que puedas hacer ahora con tus herramientas. Pon prioridad y, si procede, modelo: haiku para lo mecánico, sonnet para lo normal y opus solo para lo estratégico o muy complejo.
- Nada de relleno ni de repetir lo ya hecho. Si ahora no hay nada que aporte valor, no añadas nada y responde «Sin tareas útiles por ahora» con el motivo.${chief}`;
}

/** Encargos autónomos en marcha o en cola. */
function activeAuto(): Task[] {
  return (getDb().prepare("SELECT id FROM tasks WHERE kind = 'auto' AND status IN ('queued', 'running', 'waiting')").all() as { id: string }[])
    .map((r) => getTask(r.id))
    .filter((t): t is Task => Boolean(t));
}

/** ¿Hay encargos del usuario (o de rutinas, delegaciones…) esperando turno? Entonces el piloto cede. */
function othersQueued(): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM tasks WHERE status = 'queued' AND kind NOT IN ('auto', 'ambient') LIMIT 1").get());
}

function busy(agentId: string): boolean {
  return Boolean(
    getDb().prepare("SELECT 1 FROM tasks WHERE agent_id = ? AND status IN ('queued', 'running', 'waiting') AND kind <> 'ambient' LIMIT 1").get(agentId),
  );
}

/** Último trabajo autónomo de cada agente: el que más lleva parado va primero. */
function lastAutoAt(agentId: string): number {
  const r = getDb().prepare("SELECT MAX(created_at) AS at FROM tasks WHERE agent_id = ? AND kind = 'auto'").get(agentId) as { at: string | null };
  return r.at ? Date.parse(r.at) : 0;
}

function pickModel(wanted: ModelChoice, verdict: BudgetVerdict): ModelChoice {
  return wanted === "opus" && !verdict.allowOpus ? "sonnet" : wanted;
}

/** Cierra las tareas de la cartera cuyo encargo ya terminó y aplica las pausas de planificación. */
export function reconcile(at = new Date()) {
  for (const item of listBacklog({ statuses: ["en_curso"], limit: 200 })) {
    const task = item.taskId ? getTask(item.taskId) : null;
    if (task && ["queued", "running", "waiting"].includes(task.status)) continue;
    if (task?.status === "done") {
      updateItem(item.id, { status: "hecha", result: item.result || (task.result ?? "").slice(0, 1500) });
    } else {
      const attempts = item.attempts + 1;
      const error = task?.error ?? "El encargo desapareció.";
      updateItem(item.id, attempts >= MAX_ATTEMPTS ? { status: "descartada", attempts, result: `Bloqueada tras ${attempts} intentos: ${error}` } : { status: "pendiente", attempts, taskId: null });
    }
  }
  // Planificaciones terminadas sin ideas: que espere más antes de volver a intentarlo.
  const plans = getDb()
    .prepare("SELECT id, agent_id FROM tasks WHERE kind = 'auto' AND json_extract(data, '$.planning') = 1 AND status IN ('done', 'error', 'cancelled') AND json_extract(data, '$.reconciled') IS NULL")
    .all() as { id: string; agent_id: string }[];
  for (const p of plans) {
    const empty = listBacklog({ agentId: p.agent_id, statuses: ["pendiente", "en_curso"], limit: 1 }).length === 0;
    if (empty) setRole(p.agent_id, { planAfter: new Date(at.getTime() + PLAN_BACKOFF_MS).toISOString() });
    getDb().prepare("UPDATE tasks SET data = json_set(data, '$.reconciled', 1) WHERE id = ?").run(p.id);
  }
}

export interface AutopilotTick {
  verdict: BudgetVerdict;
  started: Task[];
}

export function tickAutopilot(at = new Date(), maxWorker = 3): AutopilotTick {
  reconcile(at);
  const settings = getAutopilotSettings();
  const verdict = judgeBudget(getStoredUsage(), settings, at);
  const started: Task[] = [];
  if (!verdict.allowed || othersQueued()) return { verdict, started };

  // Siempre queda al menos un hueco del worker para los encargos del usuario.
  const room = Math.min(settings.maxParallel, maxWorker - 1) - activeAuto().length;
  if (room <= 0) return { verdict, started };

  const roles = new Map(listRoles().map((r) => [r.agentId, r]));
  const candidates = listAgents()
    .filter((a) => !a.paused && roles.has(a.id) && !busy(a.id))
    .sort((a, b) => lastAutoAt(a.id) - lastAutoAt(b.id));

  for (const agent of candidates) {
    if (started.length >= room) break;
    const role = getRole(agent.id);
    const next = listBacklog({ agentId: agent.id, statuses: ["pendiente"], limit: 1 })[0];
    if (next) {
      const model = pickModel(next.model ?? agent.model, verdict);
      const task = createTask({
        agentId: agent.id,
        kind: "auto",
        title: next.title,
        prompt: itemPrompt(next, role),
        createdBy: "autopilot",
        data: { backlogId: next.id, model },
      });
      updateItem(next.id, { status: "en_curso", taskId: task.id });
      started.push(task);
      continue;
    }
    if (role.planAfter && Date.parse(role.planAfter) > at.getTime()) continue;
    // Planificar: el jefe con su modelo (normalmente Opus); el resto con Sonnet, que basta.
    const model = pickModel(agent.isChief ? agent.model : agent.model === "haiku" ? "haiku" : "sonnet", verdict);
    const task = createTask({
      agentId: agent.id,
      kind: "auto",
      title: "Planifica su trabajo",
      prompt: planningPrompt(agent, role),
      createdBy: "autopilot",
      data: { planning: 1, model },
    });
    setRole(agent.id, { planAfter: new Date(at.getTime() + PLAN_PAUSE_MS).toISOString() });
    started.push(task);
  }
  if (started.length) logActivity("autonomo", `Piloto automático: ${started.map((t) => `${agentName(t.agentId)} · ${t.title}`).join(" · ")}`);
  return { verdict, started };
}

function agentName(id: string) {
  return listAgents().find((a) => a.id === id)?.name ?? "?";
}
