/**
 * Presentación de la pestaña Conexiones: monograma, categoría, estado resumido
 * y reparto en secciones (activas, disponibles y próximamente). Solo lógica
 * pura (sin servidor ni React) para poder probarla.
 */

import type { OAuthState, ServiceInfo } from "./registry";
import { CATEGORIES, type UpcomingService } from "./catalog";
import type { PublicConnection } from "../repo/connections";

export type ConnView = PublicConnection & { oauth: OAuthState | null };

/** Categoría de los servicios que no la declaran. */
const CATEGORY_OF: Record<string, string> = {
  github: "dev",
  google_calendar: "agenda",
  notion: "notas",
  clima: "info",
  rss: "info",
  telegram: "avisos",
};

/**
 * Monograma del servicio (sin emojis): iniciales de las dos primeras palabras
 * («Google Calendar» → «GC»), la mayúscula interior si es una sola palabra
 * («GitHub» → «GH») o, si no, su primera letra («Slack» → «S»).
 */
export function serviceMonogram(key: string, label = ""): string {
  const words = label.replace(/[()/]/g, " ").split(/\s+/).filter((w) => /\p{L}|\d/u.test(w));
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? key;
  const inner = word.slice(1).match(/\p{Lu}/u)?.[0];
  return ((word[0] ?? "?") + (inner ?? "")).toUpperCase();
}

/** Categoría del servicio (si no la declara o no existe, «otros»). */
export function serviceCategory(key: string, declared?: string): string {
  const k = declared ?? CATEGORY_OF[key];
  return k && CATEGORIES.some((c) => c.key === k) ? k : "otros";
}

/** Nombre legible de una categoría. */
export const categoryLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label ?? "Otros";

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
  monogram: string;
}

/** Normaliza para buscar sin tildes ni mayúsculas. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** ¿El texto contiene la búsqueda (ya normalizada)? Vacía = sí. */
const matches = (q: string, ...texts: (string | undefined)[]) => !q || fold(texts.filter(Boolean).join(" ")).includes(q);

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
      monogram: serviceMonogram(s.key, s.label),
    })),
    ...upcoming.map((u) => ({
      key: u.key,
      label: u.label,
      description: u.description,
      plan: u.plan,
      available: false,
      tag: "Próximamente",
      category: serviceCategory(u.key, u.category),
      monogram: serviceMonogram(u.key, u.label),
    })),
  ];
  const q = fold(query.trim());
  return all.filter(
    (it) =>
      (filter === "todas" || (filter === "disponibles") === it.available) &&
      (category === "todas" || it.category === category) &&
      matches(q, it.label, it.description),
  );
}

/** Orden estable del catálogo: por categoría (orden de CATEGORIES) y, dentro, por nombre. */
function byCategory(a: CatalogItem, b: CatalogItem): number {
  const ca = CATEGORIES.findIndex((c) => c.key === a.category);
  const cb = CATEGORIES.findIndex((c) => c.key === b.category);
  return ca - cb || a.label.localeCompare(b.label, "es");
}

export interface ActiveCard {
  conn: ConnView;
  service?: ServiceInfo;
  status: ConnStatus;
  monogram: string;
}

export interface ConnectionSections {
  /** Conexiones ya añadidas (arriba, con contorno según su estado). */
  activas: ActiveCard[];
  /** Servicios que se pueden añadir (con cuántas conexiones tienen ya). */
  disponibles: (CatalogItem & { connected: number })[];
  /** Servicios que vendrán (abajo, en su sección; solo informativos). */
  proximamente: CatalogItem[];
}

/**
 * Reparte la pestaña en sus tres secciones, aplicando el buscador (sin tildes
 * ni mayúsculas) a nombre, servicio y descripción.
 */
export function connectionSections(services: ServiceInfo[], connections: ConnView[], upcoming: UpcomingService[], query = ""): ConnectionSections {
  const q = fold(query.trim());
  const activas = connections
    .map((conn) => {
      const service = services.find((s) => s.key === conn.service);
      return { conn, service, status: connectionStatus(conn, service), monogram: serviceMonogram(conn.service, service?.label ?? conn.name) };
    })
    .filter((a) => matches(q, a.conn.name, a.service?.label, a.service?.description))
    .sort((a, b) => a.conn.name.localeCompare(b.conn.name, "es"));
  const items = catalogItems(services, upcoming, query);
  return {
    activas,
    disponibles: items
      .filter((it) => it.available)
      .sort(byCategory)
      .map((it) => ({ ...it, connected: connections.filter((c) => c.service === it.key).length })),
    proximamente: items.filter((it) => !it.available).sort(byCategory),
  };
}
