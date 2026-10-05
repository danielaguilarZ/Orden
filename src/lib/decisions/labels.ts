/**
 * Tipos y etiquetas de Decisiones, sin dependencias de servidor (los usa
 * también la interfaz).
 *
 * Una decisión es algo que un agente necesita que el usuario decida o le dé:
 * aprobar una idea (sí/no), elegir entre opciones o responder con texto. La
 * respuesta le llega al agente que la planteó como encargo.
 */

export const DECISION_STATUSES = ["pendiente", "resuelta"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Cómo se resolvió: aceptó, rechazó, eligió una opción, respondió con texto o la retiró el agente. */
export const ANSWER_KINDS = ["aceptar", "rechazar", "opcion", "texto", "retirada"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export const MAX_OPTIONS = 6;
export const MAX_OPTION_LENGTH = 80;
export const MAX_ANSWER_LENGTH = 2000;

export interface Decision {
  id: string;
  title: string;
  /** Contexto breve en markdown: por qué se pregunta y qué pasa después. */
  context: string;
  /** Respuestas sugeridas (botones rápidos). */
  options: string[];
  /** Es un sí/no: muestra «Aceptar» y «Rechazar». */
  approval: boolean;
  authorId: string | null;
  authorName: string;
  status: DecisionStatus;
  answerKind: AnswerKind | null;
  /** Lo que respondió el usuario (opción elegida, texto o motivo del rechazo). */
  answer: string | null;
  /** Aplazada hasta esta fecha (ISO): sigue pendiente, pero no cuenta hasta entonces. */
  postponedUntil: string | null;
  /** Encargo con el que la respuesta llegó al agente. */
  taskId: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** Lo que hace el usuario desde la pestaña. */
export type DecisionAction = "responder" | "aceptar" | "rechazar" | "aplazar" | "reabrir";
export const DECISION_ACTIONS: readonly DecisionAction[] = ["responder", "aceptar", "rechazar", "aplazar", "reabrir"];

/** Nombre visible de la pestaña. */
export const TAB_LABEL = "Decisiones";

/** ¿Está aplazada todavía? */
export function isPostponed(d: Decision, at = new Date()): boolean {
  return d.status === "pendiente" && Boolean(d.postponedUntil) && d.postponedUntil! > at.toISOString();
}

export type DecisionView = "pendientes" | "aplazadas" | "resueltas";

/** En qué bloque de la pestaña sale cada decisión. */
export function viewOf(d: Decision, at = new Date()): DecisionView {
  if (d.status === "resuelta") return "resueltas";
  return isPostponed(d, at) ? "aplazadas" : "pendientes";
}

/** Pendientes: la más antigua primero (lleva más tiempo esperando). */
export function byOldest(a: Decision, b: Decision): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** Resueltas: la última resuelta primero. */
export function byResolved(a: Decision, b: Decision): number {
  return (b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt);
}

/** Resumen corto de la respuesta para el historial. */
export function answerLabel(d: Decision): string {
  switch (d.answerKind) {
    case "aceptar":
      return d.answer ? `Aceptada · ${d.answer}` : "Aceptada";
    case "rechazar":
      return d.answer ? `Rechazada · ${d.answer}` : "Rechazada";
    case "opcion":
      return `Elegiste: ${d.answer ?? ""}`;
    case "texto":
      return `Respondiste: ${d.answer ?? ""}`;
    case "retirada":
      return "Retirada por el agente";
    default:
      return d.status === "pendiente" ? "Pendiente" : "Resuelta";
  }
}
