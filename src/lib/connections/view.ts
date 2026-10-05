/**
 * Presentación de la pestaña Conexiones: icono, categoría, estado resumido y
 * filtro del catálogo. Solo lógica pura (sin servidor ni React) para poder
 * probarla.
 */

import type { OAuthState, ServiceInfo } from "./registry";
import { CATEGORIES, type ServiceCategory, type UpcomingService } from "./catalog";
import type { PublicConnection } from "../repo/connections";

export type ConnView = PublicConnection & { oauth: OAuthState | null };

/** Iconos de los servicios que no lo declaran (los primeros y los que vendrán). */
const ICONS: Record<string, string> = {
  github: "🐙",
  google_calendar: "📅",
  notion: "📝",
  clima: "⛅",
  telegram: "✈️",
  rss: "📰",
  drive: "📁",
  google_tasks: "☑️",
  gmail: "✉️",
  outlook: "📧",
  imap: "📥",
  banco: "🏦",
  whatsapp: "💬",
  spotify: "🎵",
  strava: "🏃",
};

/** Categoría de los servicios que no la declaran. */
const CATEGORY_OF: Record<string, string> = {
  github: "dev",
  google_calendar: "agenda",
  notion: "notas",
  clima: "info",
  rss: "info",
  telegram: "avisos",
};

/** Icono del servicio: el que declara, el conocido o sus iniciales («Google Calendar» → «GC»). */
export function serviceIcon(key: string, label = "", icon?: string): string {
  if (icon) return icon;
  if (ICONS[key]) return ICONS[key];
  const words = label.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? key).slice(0, 2)).toUpperCase() || "?";
}

/** Categoría del servicio (si no la declara o no existe, «otros»). */
export function serviceCategory(key: string, declared?: string): string {
  const k = declared ?? CATEGORY_OF[key];
  return k && CATEGORIES.some((c) => c.key === k) ? k : "otros";
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
  } else if (service?.supportsSecret && !service.secretOptional && !conn.hasSecret && !(conn.service === "github" && conn.auth !== "token")) {
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
  category: string;
  icon: string;
}

/** Normaliza para buscar sin tildes ni mayúsculas. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Catálogo unificado (disponibles primero) filtrado por texto, tipo y
 * categoría («todas» o la clave de una categoría).
 */
export function catalogItems(services: ServiceInfo[], upcoming: UpcomingService[], query = "", filter: CatalogFilter = "todas", category = "todas"): CatalogItem[] {
  const all: CatalogItem[] = [
    ...services.map((s) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      available: true,
      tag: s.readOnly ? "Solo lectura" : s.authKind === "oauth" ? "OAuth" : s.supportsSecret && !s.secretOptional ? "Token" : "Sin claves",
      category: serviceCategory(s.key, s.category),
      icon: serviceIcon(s.key, s.label, s.icon),
    })),
    ...upcoming.map((u) => ({
      key: u.key,
      label: u.label,
      description: u.description,
      plan: u.plan,
      available: false,
      tag: "Pronto",
      category: serviceCategory(u.key, u.category),
      icon: serviceIcon(u.key, u.label),
    })),
  ];
  const q = fold(query.trim());
  return all.filter(
    (it) =>
      (filter === "todas" || (filter === "disponibles") === it.available) &&
      (category === "todas" || it.category === category) &&
      (!q || fold(`${it.label} ${it.description}`).includes(q)),
  );
}

export interface CatalogGroup extends ServiceCategory {
  items: CatalogItem[];
}

/** Agrupa por categoría en el orden de CATEGORIES (sin grupos vacíos; dentro, disponibles primero). */
export function groupCatalog(items: CatalogItem[]): CatalogGroup[] {
  return CATEGORIES.map((c) => ({ ...c, items: items.filter((it) => it.category === c.key) })).filter((g) => g.items.length > 0);
}

/** Categorías con cuántos servicios tiene cada una (para los filtros). */
export function categoryCounts(items: CatalogItem[]): (ServiceCategory & { count: number })[] {
  return CATEGORIES.map((c) => ({ ...c, count: items.filter((it) => it.category === c.key).length })).filter((c) => c.count > 0);
}
