import { getDb, now, parseJson } from "./db";
import type { OrdenEvent } from "./types";

/**
 * Bus de eventos sobre SQLite: quien cambie algo (web o worker) inserta un
 * evento y el endpoint SSE lo reenvía a los navegadores conectados.
 */
export function emit(type: string, payload: unknown = {}): number {
  const res = getDb()
    .prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)")
    .run(type, JSON.stringify(payload), now());
  return Number(res.lastInsertRowid);
}

export function eventsAfter(afterId: number, limit = 500): OrdenEvent[] {
  const rows = getDb()
    .prepare("SELECT id, type, payload, created_at FROM events WHERE id > ? ORDER BY id LIMIT ?")
    .all(afterId, limit) as { id: number; type: string; payload: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, type: r.type, payload: parseJson(r.payload, {}), createdAt: r.created_at }));
}

export function lastEventId(): number {
  const row = getDb().prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number };
  return row.id;
}

/** Borra eventos antiguos: solo sirven para el tiempo real. */
export function pruneEvents(olderThanMs = 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = getDb().prepare("DELETE FROM events WHERE created_at < ?").run(cutoff);
  return Number(res.changes);
}
