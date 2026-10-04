import { randomUUID } from "node:crypto";
import { getDb, now, parseJson, tx } from "../db";
import { emit } from "../events";
import type { Task, TaskKind, TaskStatus, TaskUsage } from "../types";

interface TaskRow {
  id: string;
  agent_id: string;
  parent_id: string | null;
  conversation_id: string | null;
  kind: string;
  title: string;
  prompt: string;
  status: string;
  cancel_requested: number;
  result: string | null;
  error: string | null;
  created_by: string;
  data: string;
  usage: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    agentId: r.agent_id,
    parentId: r.parent_id,
    conversationId: r.conversation_id,
    kind: r.kind as TaskKind,
    title: r.title,
    prompt: r.prompt,
    status: r.status as TaskStatus,
    cancelRequested: r.cancel_requested === 1,
    result: r.result,
    error: r.error,
    createdBy: r.created_by,
    data: parseJson(r.data, {}),
    usage: r.usage ? parseJson<TaskUsage | null>(r.usage, null) : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export const ACTIVE: TaskStatus[] = ["queued", "running", "waiting"];
export const FINISHED: TaskStatus[] = ["done", "error", "cancelled"];

export function getTask(id: string): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export interface NewTask {
  agentId: string;
  kind: TaskKind;
  prompt: string;
  title?: string;
  parentId?: string | null;
  conversationId?: string | null;
  createdBy?: string;
  data?: Record<string, unknown>;
}

export function createTask(input: NewTask): Task {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, agent_id, parent_id, conversation_id, kind, title, prompt, status, created_by, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .run(
      id,
      input.agentId,
      input.parentId ?? null,
      input.conversationId ?? null,
      input.kind,
      (input.title ?? input.prompt).slice(0, 120),
      input.prompt,
      input.createdBy ?? "user",
      JSON.stringify(input.data ?? {}),
      now(),
    );
  const task = getTask(id)!;
  emit("task.created", task);
  return task;
}

export function listTasks(opts: { agentId?: string; statuses?: TaskStatus[]; limit?: number; parentId?: string; kinds?: TaskKind[] } = {}): Task[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.agentId) {
    where.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.parentId) {
    where.push("parent_id = ?");
    params.push(opts.parentId);
  }
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
    params.push(...opts.statuses);
  }
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
    params.push(...opts.kinds);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  params.push(opts.limit ?? 100);
  return (getDb().prepare(sql).all(...params) as unknown as TaskRow[]).map(toTask);
}

function update(id: string, fields: Record<string, string | number | null>): Task {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
  const task = getTask(id)!;
  emit("task.updated", task);
  return task;
}

/**
 * Reclama el siguiente encargo en cola que se pueda ejecutar: el agente no
 * está en pausa ni ocupado con otro encargo. Atómico frente a otros workers.
 */
export function claimNextTask(): Task | null {
  return tx(() => {
    const row = getDb()
      .prepare(
        `SELECT t.* FROM tasks t JOIN agents a ON a.id = t.agent_id
         WHERE t.status = 'queued' AND t.cancel_requested = 0
           AND (a.paused = 0 OR t.kind = 'ambient')
           AND (t.kind = 'ambient' OR NOT EXISTS (
             SELECT 1 FROM tasks o WHERE o.agent_id = t.agent_id AND o.status IN ('running', 'waiting') AND o.kind <> 'ambient'
           ))
         ORDER BY t.created_at, t.rowid LIMIT 1`,
      )
      .get() as unknown as TaskRow | undefined;
    if (!row) return null;
    return update(row.id, { status: "running", started_at: now() });
  });
}

export function setTaskStatus(id: string, status: TaskStatus) {
  return update(id, { status });
}

export function finishTask(
  id: string,
  status: "done" | "error" | "cancelled",
  fields: { result?: string; error?: string; usage?: TaskUsage | null } = {},
) {
  return update(id, {
    status,
    result: fields.result ?? null,
    error: fields.error ?? null,
    usage: fields.usage ? JSON.stringify(fields.usage) : null,
    finished_at: now(),
  });
}

export function mergeTaskData(id: string, patch: Record<string, unknown>) {
  const t = getTask(id);
  if (!t) return;
  update(id, { data: JSON.stringify({ ...t.data, ...patch }) });
}

/**
 * Cancela un encargo y sus delegaciones. En cola se cancela al momento
 * (aunque el worker esté parado); en marcha, el worker lo aborta al verlo.
 */
export function cancelTask(id: string): Task | null {
  return tx(() => {
    const t = getTask(id);
    if (!t || FINISHED.includes(t.status)) return t;
    const out = t.status === "queued" ? finishTask(id, "cancelled", { error: "Cancelado" }) : update(id, { cancel_requested: 1 });
    for (const child of listTasks({ parentId: id, statuses: ACTIVE })) cancelTask(child.id);
    return out;
  });
}

/** Encargos que quedaron a medias si el worker se cayó. */
export function failOrphanedTasks(reason: string): Task[] {
  const rows = listTasks({ statuses: ["running", "waiting"], limit: 1000 });
  return rows.map((t) => finishTask(t.id, "error", { error: reason }));
}

/** Agentes de la cadena de encargos (para evitar ciclos de delegación). */
export function ancestorAgentIds(taskId: string): string[] {
  const out: string[] = [];
  let t = getTask(taskId);
  while (t) {
    out.push(t.agentId);
    t = t.parentId ? getTask(t.parentId) : null;
  }
  return out;
}

export function countRunning(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get() as { n: number };
  return row.n;
}
