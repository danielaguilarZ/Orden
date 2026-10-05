/**
 * Presentación de la pestaña Conexiones: icono, estado resumido y filtro del
 * catálogo. Solo lógica pura (sin servidor ni React) para poder probarla.
 */

import type { OAuthState, ServiceInfo } from "./registry";
import type { UpcomingService } from "./catalog";
import type { PublicConnection } from "../repo/connections";

export type ConnView = PublicConnection & { oauth: OAuthState | null };

const ICONS: Record<string, string> = {
  github: "🐙",
  google_calendar: "📅",
  notion: "📝",
  clima: "⛅",
  telegram: "✈️",
  rss: "📰",
  tareas: "✅",
  drive: "📁",
  gmail: "✉️",
  outlook: "📧",
  imap: "📥",
  homeassistant: "🏠",
  banco: "🏦",
  whatsapp: "💬",
  spotify: "🎵",
};

/** Icono del servicio; si no tiene, sus iniciales («Google Calendar» → «GC»). */
export function serviceIcon(key: string, label = ""): string {
  if (ICONS[key]) return ICONS[key];
  const words = label.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? key).slice(0, 2)).toUpperCase() || "?";
}

export type StatusTone = "ok" | "warn" | "bad" | "off";
export interface ConnStatus {
  tone: StatusTone;
  label: string;
  /** Falta algo para que funcione: la acción principal es «Configurar». */
  needsSetup: boolean;
}

/** Estado en una palabra (con su color) a partir de los datos que ya hay. */
export function connectionStatus(conn: ConnView, service?: ServiceInfo): ConnStatus {
  if (!conn.enabled) return { tone: "off", label: "Pausada", needsSetup: false };
  if (service?.authKind === "oauth") {
    if (!conn.oauth?.clientConfigured) return { tone: "warn", label: "Falta configurar", needsSetup: true };
    if (!conn.oauth.authorized) return { tone: "warn", label: "Sin autorizar", needsSetup: false };
  } else if (service?.supportsSecret && !conn.hasSecret && !(conn.service === "github" && conn.auth !== "token")) {
    return { tone: "warn", label: `Falta el ${(service.secretLabel ?? "token").toLowerCase()}`, needsSetup: true };
  }
  if (conn.lastError) return { tone: "bad", label: "Con errores", needsSetup: false };
  return { tone: "ok", label: "Conectada", needsSetup: false };
}

/** Cuántos agentes tienen algún permiso sobre la conexión. */
export const grantCount = (conn: Pick<ConnView, "grants">) => Object.values(conn.grants).filter(Boolean).length;

export type CatalogFilter = "todas" | "disponibles" | "proximamente";
export interface CatalogItem {
  key: string;
  label: string;
  description: string;
  /** Solo las que vendrán: cómo se conectarán. */
  plan?: string;
  available: boolean;
  tag: string;
}

/** Normaliza para buscar sin tildes ni mayúsculas. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Catálogo unificado (disponibles primero) filtrado por texto y tipo. */
export function catalogItems(services: ServiceInfo[], upcoming: UpcomingService[], query = "", filter: CatalogFilter = "todas"): CatalogItem[] {
  const all: CatalogItem[] = [
    ...services.map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      available: true,
      tag: s.readOnly ? "Solo lectura" : s.authKind === "oauth" ? "OAuth" : s.supportsSecret ? "Token" : "Sin claves",
    })),
    ...upcoming.map((u) => ({ key: u.key, label: u.label, description: u.description, plan: u.plan, available: false, tag: "Pronto" })),
  ];
  const q = fold(query.trim());
  return all.filter(
    (it) =>
      (filter === "todas" || (filter === "disponibles") === it.available) &&
      (!q || fold(`${it.label} ${it.description}`).includes(q)),
  );
}
