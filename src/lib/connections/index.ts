import { createConnection, getConnection, listConnections, publicConnection, updateConnection, type Connection, type PublicConnection } from "../repo/connections";
import { getService, listServices, type OAuthState } from "./registry";
import "./services";

/**
 * Conexiones: gestión (alta y configuración). Lo de los agentes está en
 * agents.ts. No se crea ninguna conexión de serie: se añaden desde la pestaña
 * Conexiones. Ningún servicio escribe solo en Orden: los agentes consultan
 * cada servicio cuando lo necesitan.
 */

/** Crea una conexión validando su configuración con el servicio. */
export function addConnection(service: string, config: Record<string, unknown>, name?: string): Connection {
  const s = getService(service);
  const cfg = s.normalizeConfig(config);
  // Se compara normalizada: las antiguas pueden llevar campos que ya no se usan (p. ej. «panel»).
  const same = (c: Connection) => {
    try {
      return JSON.stringify(s.normalizeConfig(c.config)) === JSON.stringify(cfg);
    } catch {
      return false;
    }
  };
  if (listConnections(service).some(same)) throw new Error("Esa conexión ya existe.");
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

export { listServices };
