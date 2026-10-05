/**
 * Tipos y etiquetas de Propuestas, sin dependencias de servidor (los usa
 * también la interfaz).
 */

export const PROPOSAL_STATUSES = ["pendiente", "aceptada", "en_curso", "hecha", "rechazada"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  pendiente: "Pendiente",
  aceptada: "Aceptada",
  en_curso: "En curso",
  hecha: "Hecha",
  rechazada: "Rechazada",
};

export const SCOPES = {
  conexiones: "Conexiones",
  agentes: "Agentes y salas",
  casa: "Casa",
  trabajo: "Trabajo",
  finanzas: "Finanzas",
  salud: "Salud",
  aprendizaje: "Aprendizaje",
  agenda: "Agenda",
  app: "App Orden",
  otros: "Otros",
} as const;
export type ProposalScope = keyof typeof SCOPES;
export const SCOPE_KEYS = Object.keys(SCOPES) as [ProposalScope, ...ProposalScope[]];

export const PRIORITIES = ["alta", "media", "baja"] as const;
export type ProposalPriority = (typeof PRIORITIES)[number];
export const LEVELS = ["bajo", "medio", "alto"] as const;
export type ProposalLevel = (typeof LEVELS)[number];

export interface Proposal {
  id: string;
  title: string;
  /** Markdown corto. */
  description: string;
  scope: ProposalScope;
  priority: ProposalPriority;
  impact: ProposalLevel;
  effort: ProposalLevel;
  authorId: string | null;
  authorName: string;
  status: ProposalStatus;
  rejectReason: string | null;
  resultNote: string | null;
  /** Aplazada hasta esta fecha (ISO): sigue pendiente, pero no cuenta hasta entonces. */
  postponedUntil: string | null;
  /** Encargo que avisó a Zen de que la ejecute. */
  taskId: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
}

export type Decision = "aceptar" | "rechazar" | "aplazar" | "reabrir";

/** ¿Está aplazada todavía? */
export function isPostponed(p: Proposal, at = new Date()): boolean {
  return p.status === "pendiente" && Boolean(p.postponedUntil) && p.postponedUntil! > at.toISOString();
}

const PRIORITY_RANK: Record<ProposalPriority, number> = { alta: 0, media: 1, baja: 2 };

/** Orden de la lista: prioridad alta primero y, a igualdad, la más reciente. */
export function byPriority(a: Proposal, b: Proposal): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt.localeCompare(a.createdAt);
}

export type ProposalView = "decidir" | "marcha" | "aplazadas" | "historico";

/** En qué vista de la pestaña sale cada propuesta. */
export function viewOf(p: Proposal, at = new Date()): ProposalView {
  if (p.status === "pendiente") return isPostponed(p, at) ? "aplazadas" : "decidir";
  if (p.status === "aceptada" || p.status === "en_curso") return "marcha";
  return "historico";
}

/** Nombre visible de la pestaña (antes «Propuestas»). La ruta sigue siendo /propuestas. */
export const TAB_LABEL = "Acción humana";

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * Panel de lista «Acción humana · lo que necesito de ti» que Zen mantiene con lo
 * que necesita del usuario. Se busca por título (sin tildes ni mayúsculas): primero
 * el título exacto y, si no, la primera lista cuyo título empiece por «Acción humana».
 */
export function findHumanActionPanel<T extends { type: string; title: string }>(panels: readonly T[]): T | null {
  const lists = panels.filter((p) => p.type === "lista");
  const exact = plain("Acción humana · lo que necesito de ti");
  return lists.find((p) => plain(p.title) === exact) ?? lists.find((p) => plain(p.title).startsWith("accion humana")) ?? null;
}
