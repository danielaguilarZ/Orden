import { randomUUID } from "node:crypto";
import { getDb, now, parseJson, tx } from "../db";
import { emit } from "../events";
import { nextRun, scheduleSchema, type Schedule } from "../routines/schedule";

export interface Routine {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastTaskId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_task_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const toRoutine = (r: Row): Routine => ({
  id: r.id,
  agentId: r.agent_id,
  name: r.name,
  prompt: r.prompt,
  schedule: parseJson<Schedule>(r.schedule, { tipo: "diaria", hora: "08:00" }),
  enabled: r.enabled === 1,
  lastRunAt: r.last_run_at,
  nextRunAt: r.next_run_at,
  lastTaskId: r.last_task_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getRoutine(id: string): Routine | null {
  const r = getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toRoutine(r) : null;
}

export function listRoutines(agentId?: string): Routine[] {
  const rows = (agentId
    ? getDb().prepare("SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at").all(agentId)
    : getDb().prepare("SELECT * FROM routines ORDER BY created_at").all()) as unknown as Row[];
  return rows.map(toRoutine);
}

export interface RoutineInput {
  agentId: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  enabled?: boolean;
}

function computeNext(schedule: Schedule, from = new Date()): string | null {
  return nextRun(schedule, from)?.toISOString() ?? null;
}

export function createRoutine(input: RoutineInput, createdBy = "user"): Routine {
  const schedule = scheduleSchema.parse(input.schedule);
  const id = randomUUID();
  const ts = now();
  const enabled = input.enabled ?? true;
  getDb()
    .prepare(
      `INSERT INTO routines (id, agent_id, name, prompt, schedule, enabled, next_run_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.agentId, input.name.trim(), input.prompt.trim(), JSON.stringify(schedule), enabled ? 1 : 0, enabled ? computeNext(schedule) : null, createdBy, ts, ts);
  const r = getRoutine(id)!;
  emit("routine.created", r);
  return r;
}

export function updateRoutine(id: string, patch: Partial<Omit<RoutineInput, "agentId">>): Routine {
  const cur = getRoutine(id);
  if (!cur) throw new Error("No existe esa rutina.");
  const schedule = patch.schedule ? scheduleSchema.parse(patch.schedule) : cur.schedule;
  const enabled = patch.enabled ?? cur.enabled;
  const reschedule = Boolean(patch.schedule) || (patch.enabled === true && !cur.enabled);
  getDb()
    .prepare("UPDATE routines SET name = ?, prompt = ?, schedule = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(
      (patch.name ?? cur.name).trim(),
      (patch.prompt ?? cur.prompt).trim(),
      JSON.stringify(schedule),
      enabled ? 1 : 0,
      !enabled ? null : reschedule ? computeNext(schedule) : cur.nextRunAt,
      now(),
      id,
    );
  const r = getRoutine(id)!;
  emit("routine.updated", r);
  return r;
}

export function deleteRoutine(id: string) {
  getDb().prepare("DELETE FROM routines WHERE id = ?").run(id);
  emit("routine.deleted", { id });
}

/** Rutinas activas cuya hora ya llegó. */
export function dueRoutines(at = new Date()): Routine[] {
  const rows = getDb()
    .prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
    .all(at.toISOString()) as unknown as Row[];
  return rows.map(toRoutine);
}

/**
 * Marca una ejecución y programa la siguiente a partir de AHORA: si el PC
 * estuvo apagado y se saltaron varias, solo se ejecuta una (sin avalancha).
 */
export function markRoutineRun(id: string, taskId: string | null, at = new Date()): Routine {
  return tx(() => {
    const cur = getRoutine(id)!;
    const next = computeNext(cur.schedule, at);
    getDb()
      .prepare("UPDATE routines SET last_run_at = ?, next_run_at = ?, last_task_id = COALESCE(?, last_task_id), enabled = ?, updated_at = ? WHERE id = ?")
      .run(at.toISOString(), next, taskId, next ? 1 : 0, now(), id);
    const r = getRoutine(id)!;
    emit("routine.updated", r);
    return r;
  });
}
