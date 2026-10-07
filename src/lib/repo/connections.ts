import { randomUUID } from "node:crypto";
import { getDb, now, parseJson, tx } from "../db";
import { emit } from "../events";
import { decryptSecret, encryptSecret, secretHint } from "../secrets";

/**
 * Conexiones con servicios externos (GitHub…) y permisos por agente.
 * La credencial va cifrada y nunca sale de aquí hacia la interfaz.
 */

/**
 * «lectura»: leer y comentar. «completo»: además crear y modificar.
 * «admin»: además lo de más alcance (en GitHub: fusionar PRs, crear repos,
 * borrar ramas). Solo existe en los servicios que lo declaran.
 */
export type GrantLevel = "lectura" | "completo" | "admin";
export const GRANT_LEVELS: GrantLevel[] = ["lectura", "completo", "admin"];

/** ¿Este nivel incluye a `min`? (admin ⊇ completo ⊇ lectura) */
export function levelAtLeast(level: GrantLevel, min: GrantLevel): boolean {
  return GRANT_LEVELS.indexOf(level) >= GRANT_LEVELS.indexOf(min);
}

/** Cómo se autentica: «auto» = gh si está disponible, si no el token guardado. */
export type AuthMode = "auto" | "gh" | "token";
export const AUTH_MODES: AuthMode[] = ["auto", "gh", "token"];

export interface Connection {
  id: string;
  service: string;
  name: string;
  config: Record<string, unknown>;
  auth: AuthMode;
  hasSecret: boolean;
  enabled: boolean;
  statusPanelId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** agentId → nivel. */
  grants: Record<string, GrantLevel>;
  createdAt: string;
  updatedAt: string;
}

/** Lo que ve la interfaz: como Connection, más una pista del token (4 últimos caracteres). */
export interface PublicConnection extends Connection {
  secretHint: string | null;
}

interface Row {
  id: string;
  service: string;
  name: string;
  config: string;
  auth: string;
  secret: string | null;
  enabled: number;
  status_panel_id: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function grantsOf(id: string): Record<string, GrantLevel> {
  const rows = getDb().prepare("SELECT agent_id, level FROM connection_grants WHERE connection_id = ?").all(id) as { agent_id: string; level: string }[];
  return Object.fromEntries(rows.filter((r) => GRANT_LEVELS.includes(r.level as GrantLevel)).map((r) => [r.agent_id, r.level as GrantLevel]));
}

const toConnection = (r: Row): Connection => ({
  id: r.id,
  service: r.service,
  name: r.name,
  config: parseJson(r.config, {}),
  auth: AUTH_MODES.includes(r.auth as AuthMode) ? (r.auth as AuthMode) : "auto",
  hasSecret: Boolean(r.secret),
  enabled: r.enabled === 1,
  statusPanelId: r.status_panel_id,
  lastSyncAt: r.last_sync_at,
  lastError: r.last_error,
  grants: grantsOf(r.id),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getConnection(id: string): Connection | null {
  const row = getDb().prepare("SELECT * FROM connections WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toConnection(row) : null;
}

export function listConnections(service?: string): Connection[] {
  const rows = (
    service
      ? getDb().prepare("SELECT * FROM connections WHERE service = ? ORDER BY created_at").all(service)
      : getDb().prepare("SELECT * FROM connections ORDER BY created_at").all()
  ) as unknown as Row[];
  return rows.map(toConnection);
}

export function publicConnection(c: Connection): PublicConnection {
  let hint: string | null = null;
  if (c.hasSecret) {
    try {
      hint = secretHint(getConnectionSecret(c.id) ?? "");
    } catch {
      hint = "(no se puede descifrar)";
    }
  }
  return { ...c, secretHint: hint };
}

function changed(id: string) {
  const c = getConnection(id);
  if (c) emit("connection.updated", { id: c.id });
  return c;
}

export function createConnection(input: { service: string; name: string; config?: Record<string, unknown>; auth?: AuthMode }): Connection {
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare("INSERT INTO connections (id, service, name, config, auth, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
    .run(id, input.service, input.name.trim() || input.service, JSON.stringify(input.config ?? {}), input.auth ?? "auto", ts, ts);
  return changed(id)!;
}

export interface ConnectionPatch {
  name?: string;
  config?: Record<string, unknown>;
  auth?: AuthMode;
  enabled?: boolean;
  statusPanelId?: string | null;
}

export function updateConnection(id: string, patch: ConnectionPatch): Connection {
  const c = getConnection(id);
  if (!c) throw new Error("Esa conexión no existe.");
  if (patch.auth && !AUTH_MODES.includes(patch.auth)) throw new Error("Modo de acceso no válido.");
  getDb()
    .prepare("UPDATE connections SET name = ?, config = ?, auth = ?, enabled = ?, status_panel_id = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.name?.trim() || c.name,
      JSON.stringify(patch.config ?? c.config),
      patch.auth ?? c.auth,
      (patch.enabled ?? c.enabled) ? 1 : 0,
      patch.statusPanelId !== undefined ? patch.statusPanelId : c.statusPanelId,
      now(),
      id,
    );
  return changed(id)!;
}

export function deleteConnection(id: string) {
  getDb().prepare("DELETE FROM connections WHERE id = ?").run(id);
  emit("connection.updated", { id, deleted: true });
}

/** Guarda (cifrado) o borra (null) la credencial. */
export function setConnectionSecret(id: string, plain: string | null): Connection {
  if (!getConnection(id)) throw new Error("Esa conexión no existe.");
  const value = plain?.trim() ? encryptSecret(plain.trim()) : null;
  getDb().prepare("UPDATE connections SET secret = ?, updated_at = ? WHERE id = ?").run(value, now(), id);
  return changed(id)!;
}

/** Solo para el código que llama al servicio. Nunca se devuelve a la interfaz ni a los agentes. */
export function getConnectionSecret(id: string): string | null {
  const row = getDb().prepare("SELECT secret FROM connections WHERE id = ?").get(id) as { secret: string | null } | undefined;
  return row?.secret ? decryptSecret(row.secret) : null;
}

/** Da, cambia o quita (null) el permiso de un agente. */
export function setGrant(connectionId: string, agentId: string, level: GrantLevel | null): Connection {
  if (level && !GRANT_LEVELS.includes(level)) throw new Error("Nivel de permiso no válido.");
  tx(() => {
    if (level) {
      getDb()
        .prepare("INSERT INTO connection_grants (connection_id, agent_id, level) VALUES (?, ?, ?) ON CONFLICT(connection_id, agent_id) DO UPDATE SET level = excluded.level")
        .run(connectionId, agentId, level);
    } else {
      getDb().prepare("DELETE FROM connection_grants WHERE connection_id = ? AND agent_id = ?").run(connectionId, agentId);
    }
  });
  return changed(connectionId)!;
}

/** Conexiones activas que puede usar un agente, con su nivel. */
export function grantsForAgent(agentId: string, service?: string): { connection: Connection; level: GrantLevel }[] {
  return listConnections(service)
    .filter((c) => c.enabled && c.grants[agentId])
    .map((c) => ({ connection: c, level: c.grants[agentId] }));
}

/** Resultado de la última sincronización (null = sin error). */
export function markSync(id: string, error: string | null, at = new Date()) {
  getDb().prepare("UPDATE connections SET last_sync_at = ?, last_error = ? WHERE id = ?").run(at.toISOString(), error, id);
  emit("connection.updated", { id });
}
