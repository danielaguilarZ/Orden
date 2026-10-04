import { randomUUID } from "node:crypto";
import { getDb, now, tx } from "../db";
import { emit } from "../events";
import type { Actor } from "./panels";

export { MEMORY_CATEGORIES } from "../memory/categories";

export interface MemoryEntry {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  /** 'user' o id del agente que lo guardó por última vez. */
  source: string;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersion {
  id: number;
  memoryId: string;
  version: number;
  category: string;
  title: string;
  content: string;
  tags: string[];
  archived: boolean;
  actor: string;
  reason: string;
  createdAt: string;
}

interface Row {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  source: string;
  version: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

const splitTags = (t: string) => t.split(",").map((s) => s.trim()).filter(Boolean);

const toEntry = (r: Row): MemoryEntry => ({
  id: r.id,
  category: r.category,
  title: r.title,
  content: r.content,
  tags: splitTags(r.tags),
  source: r.source,
  version: r.version,
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getMemory(id: string): MemoryEntry | null {
  const r = getDb().prepare("SELECT * FROM memory WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toEntry(r) : null;
}

export function listMemory(opts: { category?: string; archived?: boolean } = {}): MemoryEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM memory WHERE archived = ? ${opts.category ? "AND category = ?" : ""} ORDER BY category, updated_at DESC`)
    .all(...([opts.archived ? 1 : 0, ...(opts.category ? [opts.category] : [])] as (string | number)[])) as unknown as Row[];
  return rows.map(toEntry);
}

const STOP = new Set(
  "para pero como con sin por que qué del las los una uno unos unas este esta estos estas ese esa eso muy mas más mis tus sus nos les ser estar hacer tengo tiene cuando donde dónde cual cuál quiero puedes favor sobre entre hasta desde también todo toda todos todas algo".split(" "),
);

/**
 * Convierte texto libre en una consulta FTS5 tolerante: palabras útiles en
 * OR y por prefijo (los 5 primeros caracteres), sin tildes.
 */
export function ftsQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const terms = [...new Set(words.map((w) => (w.length > 5 ? w.slice(0, 5) : w)))].slice(0, 16);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

/** Busca entradas relevantes (BM25, título con más peso). */
export function searchMemory(text: string, opts: { limit?: number; category?: string } = {}): MemoryEntry[] {
  const q = ftsQuery(text);
  if (!q) return [];
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM memory_fts f JOIN memory m ON m.rowid = f.rowid
       WHERE memory_fts MATCH ? AND m.archived = 0 ${opts.category ? "AND m.category = ?" : ""}
       ORDER BY bm25(memory_fts, 3.0, 1.0, 2.0) LIMIT ?`,
    )
    .all(...([q, ...(opts.category ? [opts.category] : []), opts.limit ?? 8] as (string | number)[])) as unknown as Row[];
  return rows.map(toEntry);
}

const MANUAL_COALESCE_MS = 60_000;

function lastVersion(memoryId: string) {
  return getDb().prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY id DESC LIMIT 1").get(memoryId) as
    | { version: number; actor: string; task_id: string | null; created_at: string }
    | undefined;
}

/** Instantánea del estado anterior (una por encargo / ráfaga manual). */
function snapshot(e: MemoryEntry, actor: Actor, reason: string, force = false) {
  const last = lastVersion(e.id);
  if (!force && last && last.version === e.version) return;
  if (!force && last && last.actor === actor.by) {
    if (actor.taskId && last.task_id === actor.taskId) return;
    if (!actor.taskId && actor.by === "user" && Date.now() - Date.parse(last.created_at) < MANUAL_COALESCE_MS) return;
  }
  getDb()
    .prepare(
      `INSERT INTO memory_versions (memory_id, version, category, title, content, tags, archived, actor, task_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.id, e.version, e.category, e.title, e.content, e.tags.join(", "), e.archived ? 1 : 0, actor.by, actor.taskId ?? null, reason, now());
}

export interface MemoryInput {
  category: string;
  title: string;
  content: string;
  tags?: string[];
}

export function createMemory(input: MemoryInput, actor: Actor): MemoryEntry {
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare("INSERT INTO memory (id, category, title, content, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.category, input.title.trim(), input.content.trim(), (input.tags ?? []).join(", "), actor.by, ts, ts);
  const e = getMemory(id)!;
  emit("memory.created", { entry: e, actor });
  return e;
}

export function updateMemory(
  id: string,
  patch: Partial<MemoryInput> & { archived?: boolean },
  actor: Actor,
  reason = "Editado",
  forceSnapshot = false,
): MemoryEntry {
  return tx(() => {
    const cur = getMemory(id);
    if (!cur) throw new Error(`No existe el recuerdo ${id}.`);
    snapshot(cur, actor, reason, forceSnapshot || patch.archived !== undefined);
    const next = { ...cur, ...patch, tags: patch.tags ?? cur.tags };
    getDb()
      .prepare(
        "UPDATE memory SET category = ?, title = ?, content = ?, tags = ?, archived = ?, source = ?, version = version + 1, updated_at = ? WHERE id = ?",
      )
      .run(next.category, next.title.trim(), next.content.trim(), next.tags.join(", "), next.archived ? 1 : 0, actor.by, now(), id);
    const e = getMemory(id)!;
    emit("memory.updated", { entry: e, actor });
    return e;
  });
}

/**
 * Guarda un recuerdo evitando duplicados: si ya hay uno con el mismo título
 * en la categoría, lo actualiza.
 */
export function upsertMemory(input: MemoryInput & { id?: string }, actor: Actor): { entry: MemoryEntry; created: boolean } {
  if (input.id) return { entry: updateMemory(input.id, input, actor, "Actualizado por un agente"), created: false };
  const existing = getDb()
    .prepare("SELECT id FROM memory WHERE archived = 0 AND category = ? AND lower(title) = lower(?)")
    .get(input.category, input.title.trim()) as { id: string } | undefined;
  if (existing) return { entry: updateMemory(existing.id, input, actor, "Actualizado"), created: false };
  return { entry: createMemory(input, actor), created: true };
}

/** «Olvidar» = archivar; se puede recuperar. */
export function archiveMemory(id: string, actor: Actor, archived = true): MemoryEntry {
  return updateMemory(id, { archived }, actor, archived ? "Olvidado" : "Recuperado");
}

export function listMemoryVersions(id: string): MemoryVersion[] {
  const rows = getDb().prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY id DESC LIMIT 100").all(id) as {
    id: number;
    memory_id: string;
    version: number;
    category: string;
    title: string;
    content: string;
    tags: string;
    archived: number;
    actor: string;
    reason: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    memoryId: r.memory_id,
    version: r.version,
    category: r.category,
    title: r.title,
    content: r.content,
    tags: splitTags(r.tags),
    archived: r.archived === 1,
    actor: r.actor,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

export function restoreMemoryVersion(id: string, versionId: number, actor: Actor): MemoryEntry {
  const v = listMemoryVersions(id).find((x) => x.id === versionId);
  if (!v) throw new Error("Versión no encontrada.");
  return updateMemory(
    id,
    { category: v.category, title: v.title, content: v.content, tags: v.tags, archived: v.archived },
    actor,
    `Antes de restaurar la versión ${v.version}`,
    true,
  );
}

/** Recuerdos recientes que tocaron los agentes (para el registro). */
export function memoryStats(): Record<string, number> {
  const rows = getDb().prepare("SELECT category, COUNT(*) AS n FROM memory WHERE archived = 0 GROUP BY category").all() as { category: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}
