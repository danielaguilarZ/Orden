import { getDb, now } from "../db";
import { emit } from "../events";
import { getAgent } from "../repo/agents";
import { activeConversation, addMessage } from "../repo/chat";
import { dueRoutines, getRoutine, markRoutineRun, type Routine } from "../repo/routines";
import { ACTIVE, createTask, getTask } from "../repo/tasks";
import { logActivity } from "../repo/system";
import { describeSchedule } from "./schedule";
import type { Task } from "../types";

export function routinePrompt(r: Routine): string {
  return `Rutina programada «${r.name}» (${describeSchedule(r.schedule)}).
${r.prompt}

Es una ejecución automática: el usuario no está esperando en el chat. Si encaja, deja el resultado en un panel; responde con un resumen breve.`;
}

/**
 * Lanza una rutina como encargo del worker. No se apilan: si la ejecución
 * anterior sigue en marcha, esta se salta.
 */
export function fireRoutine(r: Routine, at = new Date(), manual = false): Task | null {
  const agent = getAgent(r.agentId);
  const reschedule = (taskId: string | null) => {
    if (!manual) markRoutineRun(r.id, taskId, at);
  };
  if (!agent) {
    reschedule(null);
    return null;
  }
  const prev = r.lastTaskId ? getTask(r.lastTaskId) : null;
  if (prev && ACTIVE.includes(prev.status)) {
    reschedule(null);
    logActivity("rutina", `«${r.name}» se salta: la ejecución anterior sigue en marcha`, agent.id, { routineId: r.id });
    return null;
  }
  if (agent.paused && !manual) {
    reschedule(null);
    logActivity("rutina", `«${r.name}» no se ejecuta: ${agent.name} está en pausa`, agent.id, { routineId: r.id });
    return null;
  }
  const conv = activeConversation(agent.id);
  const task = createTask({
    agentId: agent.id,
    kind: "routine",
    conversationId: conv.id,
    title: `Rutina: ${r.name}`,
    prompt: routinePrompt(r),
    createdBy: `routine:${r.id}`,
    data: { routineId: r.id },
  });
  addMessage({
    conversationId: conv.id,
    role: "tool",
    content: `⏰ Rutina «${r.name}» (${describeSchedule(r.schedule)})${manual ? " · lanzada a mano" : ""}`,
    agentId: agent.id,
    taskId: task.id,
    data: { kind: "routine", routineId: r.id },
  });
  if (manual) {
    getDb().prepare("UPDATE routines SET last_run_at = ?, last_task_id = ?, updated_at = ? WHERE id = ?").run(at.toISOString(), task.id, now(), r.id);
    emit("routine.updated", getRoutine(r.id));
  } else reschedule(task.id);
  logActivity("rutina", `Se lanza «${r.name}» (${agent.name})`, agent.id, { routineId: r.id, taskId: task.id });
  return task;
}

/** Lo llama el worker cada pocos segundos. */
export function tickRoutines(at = new Date()): Task[] {
  return dueRoutines(at)
    .map((r) => fireRoutine(r, at))
    .filter((t): t is Task => Boolean(t));
}
