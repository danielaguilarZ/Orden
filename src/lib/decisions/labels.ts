import type { AttachmentRef } from "../files/attachments";
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
  /** Lo que adjuntó el usuario al responder (quedan en Archivos/Adjuntos). */
  attachments: AttachmentRef[];
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

/** Qué se le pide al usuario, en dos palabras (chip de la tarjeta). */
export function decisionKind(d: Pick<Decision, "approval" | "options">): { icon: string; label: string } {
  if (d.approval) return { icon: "✓", label: "Sí / No" };
  if (d.options.length) return { icon: "☰", label: `Elegir (${d.options.length})` };
  return { icon: "✎", label: "Respuesta" };
}

/** Resultado en dos partes para el histórico: estado corto (chip) y la respuesta, si la hay. */
export function answerParts(d: Pick<Decision, "answerKind" | "answer" | "status">): { state: string; detail: string } {
  const detail = d.answer?.trim() ?? "";
  switch (d.answerKind) {
    case "aceptar":
      return { state: "Aceptada", detail };
    case "rechazar":
      return { state: "Rechazada", detail };
    case "opcion":
      return { state: "Elegida", detail };
    case "texto":
      return { state: "Respondida", detail };
    case "retirada":
      return { state: "Retirada", detail: "" };
    default:
      return { state: d.status === "pendiente" ? "Pendiente" : "Resuelta", detail: "" };
  }
}

/** Color del resultado en el histórico. */
export function answerTone(kind: AnswerKind | null): "ok" | "bad" | "off" {
  if (kind === "rechazar") return "bad";
  if (kind === "retirada" || !kind) return "off";
  return "ok";
}
