import { getDb, now, parseJson } from "../db";
import { emit } from "../events";
import type { HeartbeatInfo } from "../types";

/** Si el worker no late en este tiempo, la UI lo da por parado. */
export const HEARTBEAT_STALE_MS = 30_000;

export function beat(name: string, info: Record<string, unknown> = {}) {
  getDb()
    .prepare(
      "INSERT INTO heartbeats (name, at, info) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, info = excluded.info",
    )
    .run(name, now(), JSON.stringify(info));
}

export function getHeartbeat(name: string): HeartbeatInfo | null {
  const row = getDb().prepare("SELECT name, at, info FROM heartbeats WHERE name = ?").get(name) as
    | { name: string; at: string; info: string }
    | undefined;
  if (!row) return null;
  return {
    name: row.name,
    at: row.at,
    alive: Date.now() - Date.parse(row.at) < HEARTBEAT_STALE_MS,
    info: parseJson(row.info, {}),
  };
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? parseJson<T>(row.value, fallback) : fallback;
}

export function setSetting(key: string, value: unknown) {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export function logActivity(kind: string, text: string, agentId: string | null = null, data: unknown = {}) {
  const ts = now();
  const res = getDb()
    .prepare("INSERT INTO activity (agent_id, kind, text, data, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(agentId, kind, text, JSON.stringify(data), ts);
  emit("activity.created", { id: Number(res.lastInsertRowid), agentId, kind, text, data, createdAt: ts });
}

export interface ActivityEntry {
  id: number;
  agentId: string | null;
  kind: string;
  text: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export function listActivity(opts: { agentId?: string; kind?: string; limit?: number; before?: number } = {}): ActivityEntry[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.agentId) {
    where.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.before) {
    where.push("id < ?");
    params.push(opts.before);
  }
  params.push(opts.limit ?? 100);
  const rows = getDb()
    .prepare(`SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...params) as { id: number; agent_id: string | null; kind: string; text: string; data: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, agentId: r.agent_id, kind: r.kind, text: r.text, data: parseJson(r.data, {}), createdAt: r.created_at }));
}
