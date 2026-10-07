import { randomUUID } from "node:crypto";
import { getDb, now } from "../db";
import { emit } from "../events";
import type { ModelChoice } from "../types";
import type { AgentRole, BacklogItem, BacklogSource, BacklogStatus, Unit, UnitKind } from "./types";

/** Acceso a datos de la organización: unidades, puestos y cartera. */

interface UnitRow {
  id: string;
  name: string;
  kind: string;
  summary: string;
  goals: string;
  building: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

const toUnit = (r: UnitRow): Unit => ({
  id: r.id,
  name: r.name,
  kind: r.kind as UnitKind,
  summary: r.summary,
  goals: r.goals,
  building: r.building,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listUnits(): Unit[] {
  return (getDb().prepare("SELECT * FROM units ORDER BY position, created_at").all() as unknown as UnitRow[]).map(toUnit);
}

export function getUnit(id: string): Unit | null {
  const r = getDb().prepare("SELECT * FROM units WHERE id = ?").get(id) as unknown as UnitRow | undefined;
  return r ? toUnit(r) : null;
}

export function findUnitByName(name: string): Unit | null {
  const r = getDb().prepare("SELECT * FROM units WHERE name = ? COLLATE NOCASE").get(name.trim()) as unknown as UnitRow | undefined;
  return r ? toUnit(r) : null;
}

export interface UnitInput {
  name: string;
  kind: UnitKind;
  summary?: string;
  goals?: string;
  building?: string | null;
}

export function createUnit(input: UnitInput): Unit {
  if (findUnitByName(input.name)) throw new Error(`Ya existe la unidad «${input.name}».`);
  const id = randomUUID();
  const ts = now();
  const position = (getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM units").get() as { p: number }).p;
  getDb()
    .prepare("INSERT INTO units (id, name, kind, summary, goals, building, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.name.trim(), input.kind, input.summary ?? "", input.goals ?? "", input.building ?? null, position, ts, ts);
  const unit = getUnit(id)!;
  emit("unit.updated", unit);
  return unit;
}

export function updateUnit(id: string, patch: Partial<UnitInput>): Unit {
  const cur = getUnit(id);
  if (!cur) throw new Error("No existe esa unidad.");
  if (patch.name && patch.name.trim().toLowerCase() !== cur.name.toLowerCase() && findUnitByName(patch.name)) {
    throw new Error(`Ya existe la unidad «${patch.name}».`);
  }
  const next = { ...cur, ...patch, name: (patch.name ?? cur.name).trim() };
  getDb()
    .prepare("UPDATE units SET name = ?, kind = ?, summary = ?, goals = ?, building = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.kind, next.summary, next.goals, next.building ?? null, now(), id);
  const unit = getUnit(id)!;
  emit("unit.updated", unit);
  return unit;
}

export function deleteUnit(id: string) {
  getDb().prepare("DELETE FROM units WHERE id = ?").run(id);
  emit("unit.deleted", { id });
}

// ───────────────────────── Puestos ─────────────────────────

interface RoleRow {
  agent_id: string;
  unit_id: string | null;
  role: string;
  duties: string;
  lead: number;
  plan_after: string | null;
}

const toRole = (r: RoleRow): AgentRole => ({
  agentId: r.agent_id,
  unitId: r.unit_id,
  role: r.role,
  duties: r.duties,
  lead: r.lead === 1,
  planAfter: r.plan_after,
});

const EMPTY_ROLE = (agentId: string): AgentRole => ({ agentId, unitId: null, role: "", duties: "", lead: false, planAfter: null });

export function getRole(agentId: string): AgentRole {
  const r = getDb().prepare("SELECT * FROM agent_roles WHERE agent_id = ?").get(agentId) as unknown as RoleRow | undefined;
  return r ? toRole(r) : EMPTY_ROLE(agentId);
}

export function listRoles(): AgentRole[] {
  return (getDb().prepare("SELECT * FROM agent_roles").all() as unknown as RoleRow[]).map(toRole);
}

export function setRole(agentId: string, patch: Partial<Omit<AgentRole, "agentId">>): AgentRole {
  const next = { ...getRole(agentId), ...patch };
  getDb()
    .prepare(
      `INSERT INTO agent_roles (agent_id, unit_id, role, duties, lead, plan_after, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET unit_id = excluded.unit_id, role = excluded.role, duties = excluded.duties,
         lead = excluded.lead, plan_after = excluded.plan_after, updated_at = excluded.updated_at`,
    )
    .run(agentId, next.unitId, next.role, next.duties, next.lead ? 1 : 0, next.planAfter, now());
  const role = getRole(agentId);
  emit("role.updated", role);
  return role;
}

// ───────────────────────── Cartera ─────────────────────────

interface BacklogRow {
  id: string;
  agent_id: string;
  unit_id: string | null;
  title: string;
  detail: string;
  priority: number;
  model: string | null;
  status: string;
  source: string;
  created_by: string | null;
  task_id: string | null;
  attempts: number;
  result: string;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

const toItem = (r: BacklogRow): BacklogItem => ({
  id: r.id,
  agentId: r.agent_id,
  unitId: r.unit_id,
  title: r.title,
  detail: r.detail,
  priority: Math.min(3, Math.max(1, r.priority)) as 1 | 2 | 3,
  model: (r.model as ModelChoice | null) ?? null,
  status: r.status as BacklogStatus,
  source: r.source as BacklogSource,
  createdBy: r.created_by,
  taskId: r.task_id,
  attempts: r.attempts,
  result: r.result,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  doneAt: r.done_at,
});

export function getItem(id: string): BacklogItem | null {
  const r = getDb().prepare("SELECT * FROM backlog WHERE id = ?").get(id) as unknown as BacklogRow | undefined;
  return r ? toItem(r) : null;
}

/** Id corto (8 caracteres) o completo, como los muestran las herramientas. */
export function findItem(ref: string): BacklogItem | null {
  const r = getDb().prepare("SELECT * FROM backlog WHERE id = ? OR id LIKE ? LIMIT 2").all(ref, `${ref}%`) as unknown as BacklogRow[];
  return r.length === 1 ? toItem(r[0]) : null;
}

export function listBacklog(opts: { agentId?: string; statuses?: BacklogStatus[]; limit?: number } = {}): BacklogItem[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.agentId) {
    where.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
    params.push(...opts.statuses);
  }
  params.push(opts.limit ?? 100);
  const sql = `SELECT * FROM backlog ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY CASE status WHEN 'en_curso' THEN 0 WHEN 'pendiente' THEN 1 ELSE 2 END, priority, created_at LIMIT ?`;
  return (getDb().prepare(sql).all(...params) as unknown as BacklogRow[]).map(toItem);
}

export interface NewItem {
  agentId: string;
  title: string;
  detail?: string;
  unitId?: string | null;
  priority?: 1 | 2 | 3;
  model?: ModelChoice | null;
  source?: BacklogSource;
  createdBy?: string | null;
}

/** Límite de tareas pendientes por agente: una cartera infinita es ruido, no trabajo. */
export const MAX_PENDING = 12;

export function addItem(input: NewItem): BacklogItem {
  const pending = listBacklog({ agentId: input.agentId, statuses: ["pendiente"], limit: MAX_PENDING + 1 }).length;
  if (pending >= MAX_PENDING) throw new Error(`Su cartera ya tiene ${MAX_PENDING} tareas pendientes: termina o descarta alguna antes.`);
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO backlog (id, agent_id, unit_id, title, detail, priority, model, status, source, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.agentId,
      input.unitId ?? null,
      input.title.trim().slice(0, 140),
      (input.detail ?? "").trim().slice(0, 4000),
      input.priority ?? 2,
      input.model ?? null,
      input.source ?? "usuario",
      input.createdBy ?? null,
      ts,
      ts,
    );
  const item = getItem(id)!;
  emit("backlog.updated", item);
  return item;
}

export function updateItem(
  id: string,
  patch: Partial<Pick<BacklogItem, "title" | "detail" | "priority" | "model" | "status" | "taskId" | "attempts" | "result" | "unitId" | "agentId">>,
): BacklogItem {
  const cur = getItem(id);
  if (!cur) throw new Error("No existe esa tarea de la cartera.");
  const next = { ...cur, ...patch };
  const finished = next.status === "hecha" || next.status === "descartada";
  getDb()
    .prepare(
      `UPDATE backlog SET agent_id = ?, unit_id = ?, title = ?, detail = ?, priority = ?, model = ?, status = ?, task_id = ?,
         attempts = ?, result = ?, updated_at = ?, done_at = ? WHERE id = ?`,
    )
    .run(
      next.agentId,
      next.unitId,
      next.title,
      next.detail,
      next.priority,
      next.model,
      next.status,
      next.taskId,
      next.attempts,
      next.result.slice(0, 4000),
      now(),
      finished ? (cur.doneAt ?? now()) : null,
      id,
    );
  const item = getItem(id)!;
  emit("backlog.updated", item);
  return item;
}

export function deleteItem(id: string) {
  getDb().prepare("DELETE FROM backlog WHERE id = ?").run(id);
  emit("backlog.deleted", { id });
}
