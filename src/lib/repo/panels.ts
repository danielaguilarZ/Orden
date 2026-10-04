import { randomUUID } from "node:crypto";
import { getDb, now, parseJson, tx } from "../db";
import { emit } from "../events";
import { applyOp, getPanelType, normalizeData, type OpInput } from "../panels/types";

export interface PanelLayout {
  order?: number;
  size?: "normal" | "ancho" | "alto" | "grande";
}

export interface Panel {
  id: string;
  type: string;
  title: string;
  data: unknown;
  layout: PanelLayout;
  agentId: string | null;
  version: number;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PanelVersion {
  id: number;
  panelId: string;
  version: number;
  title: string;
  data: unknown;
  actor: string;
  taskId: string | null;
  reason: string;
  createdAt: string;
}

/** Quién cambia un panel: el usuario o un agente dentro de un encargo. */
export interface Actor {
  by: string; // "user" o id del agente
  taskId?: string | null;
}

interface PanelRow {
  id: string;
  type: string;
  title: string;
  data: string;
  layout: string;
  agent_id: string | null;
  version: number;
  archived: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const toPanel = (r: PanelRow): Panel => ({
  id: r.id,
  type: r.type,
  title: r.title,
  data: parseJson(r.data, {}),
  layout: parseJson(r.layout, {}),
  agentId: r.agent_id,
  version: r.version,
  archived: r.archived === 1,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getPanel(id: string): Panel | null {
  const row = getDb().prepare("SELECT * FROM panels WHERE id = ?").get(id) as unknown as PanelRow | undefined;
  return row ? toPanel(row) : null;
}

/** Busca por id o, si no, por título exacto (sin mayúsculas). */
export function findPanel(ref: string): Panel | null {
  const byId = getPanel(ref);
  if (byId) return byId;
  const row = getDb()
    .prepare("SELECT * FROM panels WHERE lower(title) = lower(?) AND archived = 0 ORDER BY updated_at DESC LIMIT 1")
    .get(ref.trim()) as unknown as PanelRow | undefined;
  return row ? toPanel(row) : null;
}

export function listPanels(opts: { archived?: boolean } = {}): Panel[] {
  const rows = getDb()
    .prepare("SELECT * FROM panels WHERE archived = ? ORDER BY updated_at DESC")
    .all(opts.archived ? 1 : 0) as unknown as PanelRow[];
  return rows.map(toPanel).sort((a, b) => (a.layout.order ?? 1e9) - (b.layout.order ?? 1e9) || b.updatedAt.localeCompare(a.updatedAt));
}

export function createPanel(input: { type: string; title: string; data?: unknown; agentId?: string | null; actor: Actor; layout?: PanelLayout }): Panel {
  getPanelType(input.type);
  const id = randomUUID();
  const ts = now();
  const data = normalizeData(input.type, input.data);
  const minOrder = (getDb().prepare("SELECT MIN(json_extract(layout, '$.order')) AS m FROM panels WHERE archived = 0").get() as { m: number | null }).m;
  // Los tipos «anchos» empiezan ocupando dos columnas del tablero.
  const wide = ["calendario", "kanban", "tabla", "habitos"].includes(input.type);
  const layout = { order: (minOrder ?? 1) - 1, size: wide ? "ancho" : "normal", ...input.layout } as PanelLayout;
  getDb()
    .prepare(
      `INSERT INTO panels (id, type, title, data, layout, agent_id, version, archived, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    )
    .run(id, input.type, input.title.trim() || getPanelType(input.type).label, JSON.stringify(data), JSON.stringify(layout), input.agentId ?? null, input.actor.by, ts, ts);
  const panel = getPanel(id)!;
  emit("panel.created", { panel, actor: input.actor });
  return panel;
}

function lastVersion(panelId: string): PanelVersion | null {
  const row = getDb().prepare("SELECT * FROM panel_versions WHERE panel_id = ? ORDER BY id DESC LIMIT 1").get(panelId) as
    | { id: number; panel_id: string; version: number; title: string; data: string; actor: string; task_id: string | null; reason: string; created_at: string }
    | undefined;
  return row
    ? {
        id: row.id,
        panelId: row.panel_id,
        version: row.version,
        title: row.title,
        data: parseJson(row.data, {}),
        actor: row.actor,
        taskId: row.task_id,
        reason: row.reason,
        createdAt: row.created_at,
      }
    : null;
}

const MANUAL_COALESCE_MS = 60_000;

/**
 * Guarda el estado actual antes de cambiarlo. Una instantánea por encargo
 * de agente; las ediciones manuales seguidas (menos de 1 min) se agrupan.
 */
function snapshotBeforeChange(panel: Panel, actor: Actor, reason: string, force = false) {
  const last = lastVersion(panel.id);
  if (!force && last && last.version === panel.version) return; // ya está guardado este estado
  if (!force && last && last.actor === actor.by) {
    if (actor.taskId && last.taskId === actor.taskId) return;
    if (!actor.taskId && actor.by === "user" && Date.now() - Date.parse(last.createdAt) < MANUAL_COALESCE_MS) return;
  }
  getDb()
    .prepare("INSERT INTO panel_versions (panel_id, version, title, data, actor, task_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(panel.id, panel.version, panel.title, JSON.stringify(panel.data), actor.by, actor.taskId ?? null, reason, now());
}

function save(panel: Panel, fields: { title?: string; data?: unknown; archived?: boolean }, actor: Actor, event = "panel.updated") {
  getDb()
    .prepare("UPDATE panels SET title = ?, data = ?, archived = ?, version = version + 1, updated_at = ? WHERE id = ?")
    .run(
      fields.title ?? panel.title,
      JSON.stringify(fields.data ?? panel.data),
      (fields.archived ?? panel.archived) ? 1 : 0,
      now(),
      panel.id,
    );
  const updated = getPanel(panel.id)!;
  emit(event, { panel: updated, actor });
  return updated;
}

export interface OpsResult {
  panel: Panel;
  applied: number;
  error?: string;
}

/**
 * Aplica operaciones una a una, guardando y emitiendo cada paso para que la
 * interfaz vea cómo se construye. Se detiene en la primera que falle.
 */
export async function applyPanelOps(
  id: string,
  ops: OpInput[],
  actor: Actor,
  opts: { stepDelayMs?: number } = {},
): Promise<OpsResult> {
  let panel = getPanel(id);
  if (!panel) throw new Error(`No existe el panel ${id}.`);
  snapshotBeforeChange(panel, actor, actor.taskId ? "Cambios de un agente" : "Edición manual");
  let applied = 0;
  for (const input of ops) {
    try {
      const data = applyOp(panel.type, panel.data, input);
      panel = save(panel, { data }, actor);
      applied++;
    } catch (err) {
      return { panel, applied, error: `Operación ${applied + 1} (${input.op}): ${(err as Error).message}` };
    }
    if (opts.stepDelayMs && applied < ops.length) await new Promise((r) => setTimeout(r, opts.stepDelayMs));
  }
  return { panel, applied };
}

/** Sustituye todos los datos (validados). */
export function replacePanelData(id: string, data: unknown, actor: Actor): Panel {
  const panel = getPanel(id);
  if (!panel) throw new Error(`No existe el panel ${id}.`);
  snapshotBeforeChange(panel, actor, "Datos sustituidos");
  return save(panel, { data: normalizeData(panel.type, data) }, actor);
}

export function renamePanel(id: string, title: string, actor: Actor): Panel {
  const panel = getPanel(id);
  if (!panel) throw new Error(`No existe el panel ${id}.`);
  snapshotBeforeChange(panel, actor, "Renombrado");
  return save(panel, { title: title.trim() || panel.title }, actor);
}

/** «Borrar» = archivar: se puede recuperar desde la papelera. */
export function archivePanel(id: string, actor: Actor, archived = true): Panel {
  const panel = getPanel(id);
  if (!panel) throw new Error(`No existe el panel ${id}.`);
  snapshotBeforeChange(panel, actor, archived ? "Archivado" : "Recuperado", true);
  return save(panel, { archived }, actor, archived ? "panel.archived" : "panel.updated");
}

export function deletePanelForever(id: string) {
  getDb().prepare("DELETE FROM panels WHERE id = ?").run(id);
  emit("panel.deleted", { id });
}

export function setPanelLayout(id: string, layout: PanelLayout): Panel {
  const panel = getPanel(id);
  if (!panel) throw new Error(`No existe el panel ${id}.`);
  getDb().prepare("UPDATE panels SET layout = ? WHERE id = ?").run(JSON.stringify({ ...panel.layout, ...layout }), id);
  const updated = getPanel(id)!;
  emit("panel.layout", { panel: updated });
  return updated;
}

/** Reordena los paneles según la lista de ids. */
export function reorderPanels(ids: string[]) {
  tx(() => {
    ids.forEach((id, i) => {
      const p = getPanel(id);
      if (p) getDb().prepare("UPDATE panels SET layout = ? WHERE id = ?").run(JSON.stringify({ ...p.layout, order: i }), id);
    });
  });
  emit("panel.reordered", { ids });
}

export function listVersions(panelId: string): PanelVersion[] {
  const rows = getDb().prepare("SELECT id FROM panel_versions WHERE panel_id = ? ORDER BY id DESC LIMIT 100").all(panelId) as { id: number }[];
  return rows.map((r) => getVersion(r.id)!);
}

export function getVersion(versionId: number): PanelVersion | null {
  const row = getDb().prepare("SELECT * FROM panel_versions WHERE id = ?").get(versionId) as
    | { id: number; panel_id: string; version: number; title: string; data: string; actor: string; task_id: string | null; reason: string; created_at: string }
    | undefined;
  return row
    ? {
        id: row.id,
        panelId: row.panel_id,
        version: row.version,
        title: row.title,
        data: parseJson(row.data, {}),
        actor: row.actor,
        taskId: row.task_id,
        reason: row.reason,
        createdAt: row.created_at,
      }
    : null;
}

/** Vuelve a una versión anterior (guardando antes la actual: se puede deshacer). */
export function restoreVersion(panelId: string, versionId: number, actor: Actor): Panel {
  const panel = getPanel(panelId);
  const v = getVersion(versionId);
  if (!panel || !v || v.panelId !== panelId) throw new Error("Versión no encontrada.");
  snapshotBeforeChange(panel, actor, `Antes de restaurar la versión ${v.version}`, true);
  return save(panel, { title: v.title, data: normalizeData(panel.type, v.data), archived: false }, actor);
}
