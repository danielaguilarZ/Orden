import { createConnection, getConnection, listConnections, publicConnection, updateConnection, type Connection, type PublicConnection } from "../repo/connections";
import { getService, listServices, type OAuthState } from "./registry";
import "./services";

/**
 * Conexiones: gestión (alta y configuración) y sincronización de los paneles
 * vivos. Lo de los agentes está en agents.ts. No se crea ninguna conexión
 * de serie: se añaden desde la pestaña Conexiones.
 */

/** Crea una conexión validando su configuración con el servicio. */
export function addConnection(service: string, config: Record<string, unknown>, name?: string): Connection {
  const s = getService(service);
  const cfg = s.normalizeConfig(config);
  if (listConnections(service).some((c) => JSON.stringify(c.config) === JSON.stringify(cfg))) throw new Error("Esa conexión ya existe.");
  return createConnection({ service, name: name?.trim() || s.defaultName(cfg), config: cfg });
}

/** Cambia la configuración (validada). */
export function editConnectionConfig(id: string, config: Record<string, unknown>): Connection {
  const c = getConnection(id);
  if (!c) throw new Error("Esa conexión no existe.");
  return updateConnection(id, { config: getService(c.service).normalizeConfig({ ...c.config, ...config }) });
}

/** Lo que ve la interfaz: sin secretos y, si es OAuth, su estado. */
export function connectionView(c: Connection): PublicConnection & { oauth: OAuthState | null } {
  const s = getService(c.service);
  const pub = publicConnection(c);
  return { ...pub, secretHint: s.supportsSecret ? pub.secretHint : null, oauth: s.oauthState?.(c) ?? null };
}

const syncing = new Set<string>();

/** Lo llama el worker cada minuto: sincroniza las conexiones que tocan. */
export async function syncDueConnections(at = new Date()): Promise<string[]> {
  const done: string[] = [];
  for (const c of listConnections()) {
    const s = getService(c.service);
    if (!c.enabled || !s.sync || syncing.has(c.id)) continue;
    const every = s.syncEveryMs ?? 10 * 60_000;
    if (c.lastSyncAt && at.getTime() - Date.parse(c.lastSyncAt) < every) continue;
    syncing.add(c.id);
    try {
      if ((await s.sync(c, at)) !== false) done.push(c.name);
    } catch {
      // El error ya queda guardado en la conexión y en Actividad.
    } finally {
      syncing.delete(c.id);
    }
  }
  return done;
}

/** Sincroniza una conexión ya (botón «Actualizar ahora»). */
export async function syncConnectionNow(id: string): Promise<Connection> {
  const c = getConnection(id);
  if (!c) throw new Error("Esa conexión no existe.");
  const s = getService(c.service);
  if (!s.sync) throw new Error("Este servicio no tiene panel que actualizar.");
  if ((await s.sync(c)) === false) throw new Error(s.authKind === "oauth" ? "Primero hay que autorizar la conexión («Autorizar con Google»)." : "No había nada que actualizar.");
  return getConnection(id)!;
}

export { listServices };
