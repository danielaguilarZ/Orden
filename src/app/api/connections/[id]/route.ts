import { route, body, type IdCtx } from "@/lib/http";
import { connectionView, editConnectionConfig, syncConnectionNow } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { disconnect, redirectUriFor, saveClient, startAuth } from "@/lib/connections/google/api";
import { getAgent } from "@/lib/repo/agents";
import { getPanel } from "@/lib/repo/panels";
import { logActivity } from "@/lib/repo/system";
import {
  AUTH_MODES,
  deleteConnection,
  getConnection,
  GRANT_LEVELS,
  setConnectionSecret,
  setGrant,
  updateConnection,
  type AuthMode,
  type GrantLevel,
} from "@/lib/repo/connections";

export const dynamic = "force-dynamic";

interface Patch {
  name?: string;
  enabled?: boolean;
  auth?: AuthMode;
  config?: Record<string, unknown>;
  /** Texto = guardar (cifrado); null = borrar. Nunca se devuelve. */
  token?: string | null;
  /** Cliente OAuth (Google): id y secreto, o el JSON descargado en clientId. Se guarda cifrado. */
  oauthClient?: { clientId?: string; clientSecret?: string };
  /** agentId → nivel (null = sin acceso). */
  grants?: Record<string, GrantLevel | null>;
}

function load(id: string) {
  const c = getConnection(id);
  if (!c) throw new Error("Esa conexión no existe.");
  return c;
}

export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const c = load(id);
  const service = getService(c.service);
  const b = await body<Patch>(req);
  if (b.auth !== undefined && !AUTH_MODES.includes(b.auth)) throw new Error("Modo de acceso no válido.");
  if (b.config) editConnectionConfig(id, b.config);
  if (b.name !== undefined || b.enabled !== undefined || b.auth !== undefined) updateConnection(id, { name: b.name, enabled: b.enabled, auth: b.auth });
  if (b.token !== undefined) {
    if (!service.supportsSecret) throw new Error("Este servicio no usa token.");
    setConnectionSecret(id, b.token);
    logActivity("sistema", `${b.token ? "Token guardado" : "Token borrado"} en la conexión «${c.name}»`);
  }
  if (b.oauthClient) {
    if (service.authKind !== "oauth") throw new Error("Este servicio no usa OAuth.");
    saveClient(id, b.oauthClient.clientId ?? "", b.oauthClient.clientSecret);
    logActivity("sistema", `Credenciales OAuth guardadas (cifradas) en la conexión «${c.name}»`);
  }
  for (const [agentId, level] of Object.entries(b.grants ?? {})) {
    if (!getAgent(agentId)) throw new Error("Ese agente no existe.");
    if (level !== null && !GRANT_LEVELS.includes(level)) throw new Error("Nivel de permiso no válido.");
    if (level === "completo" && service.readOnly) throw new Error(`${service.label} es solo de lectura: el permiso máximo es «lectura».`);
    setGrant(id, agentId, level);
    logActivity("equipo", `${getAgent(agentId)!.name}: ${level ? `acceso ${level}` : "sin acceso"} a «${c.name}»`, agentId);
  }
  return connectionView(load(id));
});

export const DELETE = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  const c = load(id);
  if (getService(c.service).authKind === "oauth") await disconnect(id);
  deleteConnection(id);
  logActivity("sistema", `Conexión «${c.name}» eliminada`);
  return { ok: true };
});

/**
 * Acciones: «probar» el acceso, «actualizar» su panel ahora y, en OAuth,
 * «autorizar» (devuelve la URL de Google) o «desconectar».
 */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const c = load(id);
  const service = getService(c.service);
  const { accion } = await body<{ accion?: string }>(req);
  if (accion === "probar") return service.test(c);
  if (accion === "autorizar") {
    if (service.authKind !== "oauth") throw new Error("Este servicio no usa OAuth.");
    return { ok: true, url: startAuth(c, redirectUriFor(req.headers.get("host"))) };
  }
  if (accion === "desconectar") {
    if (service.authKind !== "oauth") throw new Error("Este servicio no usa OAuth.");
    await disconnect(id);
    logActivity("sistema", `Autorización de «${c.name}» retirada (y revocada en Google)`);
    return { ok: true, text: "Autorización retirada." };
  }
  if (accion === "actualizar") {
    // Si estaba desactivado o en la papelera, se reactiva con un panel nuevo.
    if (c.config.panel === false) editConnectionConfig(id, { panel: true });
    if (c.statusPanelId && getPanel(c.statusPanelId)?.archived) updateConnection(id, { statusPanelId: null });
    try {
      await syncConnectionNow(id);
      return { ok: true, text: service.authKind === "oauth" ? "Calendario volcado." : "Panel actualizado." };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  }
  throw new Error("Acción desconocida.");
});
