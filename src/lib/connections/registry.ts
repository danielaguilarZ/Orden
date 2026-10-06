import type { ToolContext, ToolDef } from "../agents/tools";
import type { Connection, GrantLevel } from "../repo/connections";

/**
 * Catálogo de servicios conectables. Cada servicio declara su configuración,
 * sus herramientas según el nivel de permiso y cómo probar el acceso.
 * Añadir un servicio = un módulo que llama a `registerService`.
 */

export interface AgentGrant {
  connection: Connection;
  level: GrantLevel;
}

export interface ServiceInfo {
  key: string;
  label: string;
  description: string;
  /** Qué permite cada nivel (se muestra en la interfaz). */
  levels: Record<GrantLevel, string>;
  /** Campos de configuración que pide la interfaz. */
  fields: { key: string; label: string; placeholder?: string }[];
  /** Admite credencial guardada (token) además de la del sistema. */
  supportsSecret: boolean;
  /** Cómo se autoriza: token/gh (GitHub) u OAuth en el navegador (Google). */
  authKind?: "token" | "oauth";
  /** Solo lectura: no se puede dar permiso «completo». */
  readOnly?: boolean;
  /** Cómo conectarla, paso a paso (se muestra en la ficha). */
  steps?: string[];
  /** Nombre y ejemplo de la credencial (si usa token). */
  secretLabel?: string;
  secretPlaceholder?: string;
  /** La credencial es opcional (p. ej. ntfy en un tema público). */
  secretOptional?: boolean;
  /** Categoría del catálogo (ver CATEGORIES en catalog.ts). */
  category?: string;
  /** Icono (emoji) del servicio. */
  icon?: string;
}

/** Estado OAuth que ve la interfaz (sin secretos). */
export interface OAuthState {
  clientConfigured: boolean;
  clientIdHint: string | null;
  authorized: boolean;
  account: string | null;
}

export interface ConnectionService extends ServiceInfo {
  /** Valida y normaliza la configuración; lanza un error en español si no vale. */
  normalizeConfig(input: Record<string, unknown>): Record<string, unknown>;
  defaultName(config: Record<string, unknown>): string;
  /** Herramientas para un agente con estas conexiones (ya filtradas por agente). */
  tools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[];
  /** Sección del prompt de sistema para ese agente. */
  prompt(grants: AgentGrant[]): string;
  /** Comprueba el acceso; texto legible para la interfaz. */
  test(connection: Connection): Promise<{ ok: boolean; text: string }>;
  /** Estado OAuth para la interfaz (servicios con authKind «oauth»). */
  oauthState?(connection: Connection): OAuthState;
}

const services = new Map<string, ConnectionService>();

export function registerService(service: ConnectionService) {
  services.set(service.key, service);
}

export function getService(key: string): ConnectionService {
  const s = services.get(key);
  if (!s) throw new Error(`Servicio desconocido: ${key}.`);
  return s;
}

export function listServices(): ConnectionService[] {
  return [...services.values()];
}

/** Lo que necesita la interfaz de cada servicio (sin funciones). */
export function serviceInfo(s: ConnectionService): ServiceInfo {
  return {
    key: s.key,
    label: s.label,
    description: s.description,
    levels: s.levels,
    fields: s.fields,
    supportsSecret: s.supportsSecret,
    authKind: s.authKind ?? "token",
    readOnly: Boolean(s.readOnly),
    steps: s.steps ?? [],
    secretLabel: s.secretLabel,
    secretPlaceholder: s.secretPlaceholder,
    secretOptional: Boolean(s.secretOptional),
    category: s.category,
    icon: s.icon,
  };
}
