import { randomUUID } from "node:crypto";
import { getDb, now, parseJson, tx } from "../db";
import type { AttachmentRef } from "../files/attachments";
import { emit } from "../events";
import { getAgent, getChief } from "../repo/agents";
import { activeConversation, addMessage } from "../repo/chat";
import { createTask } from "../repo/tasks";
import { logActivity } from "../repo/system";
import type { Agent } from "../types";
import {
  ANSWER_KINDS,
  MAX_ANSWER_LENGTH,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  TAB_LABEL,
  type AnswerKind,
  type Decision,
  type DecisionStatus,
} from "./labels";

export * from "./labels";

/**
 * Decisiones: lo que un agente necesita que el usuario decida o le dé. El
 * usuario responde desde la pestaña «Decisiones» (texto libre, una opción
 * sugerida o aceptar/rechazar) y la respuesta le llega al agente que la
 * planteó como un mensaje en su chat. Lo rechazado (con su motivo) no se
 * vuelve a plantear.
 */

interface Row {
  id: string;
  title: string;
  context: string;
  options: string;
  approval: number;
  author_id: string | null;
  author_name: string;
  status: string;
  answer_kind: string | null;
  answer: string | null;
  postponed_until: string | null;
  task_id: string | null;
  source: string | null;
  attachments: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function parseOptions(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toDecision(r: Row): Decision {
  return {
    id: r.id,
    title: r.title,
    context: r.context,
    options: parseOptions(r.options),
    approval: Boolean(r.approval),
    authorId: r.author_id,
    authorName: r.author_name,
    status: r.status as DecisionStatus,
    answerKind: (ANSWER_KINDS as readonly string[]).includes(r.answer_kind ?? "") ? (r.answer_kind as AnswerKind) : null,
    answer: r.answer,
    postponedUntil: r.postponed_until,
    taskId: r.task_id,
    source: r.source,
    attachments: parseJson(r.attachments ?? "[]", []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

export function getDecision(id: string): Decision | null {
  const row = getDb().prepare("SELECT * FROM decisions WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toDecision(row) : null;
}

/** Por id completo o por sus primeros caracteres (mín. 6), como los ids cortos de las herramientas. */
export function findDecision(ref: string): Decision | null {
  const r = ref.trim();
  const exact = getDecision(r);
  if (exact) return exact;
  if (r.length < 6 || !/^[0-9a-f-]+$/i.test(r)) return null;
  const rows = getDb().prepare("SELECT * FROM decisions WHERE id LIKE ? LIMIT 2").all(`${r.toLowerCase()}%`) as unknown as Row[];
  return rows.length === 1 ? toDecision(rows[0]) : null;
}

export function listDecisions(opts: { statuses?: DecisionStatus[]; authorId?: string; limit?: number } = {}): Decision[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
    params.push(...opts.statuses);
  }
  if (opts.authorId) {
    where.push("author_id = ?");
    params.push(opts.authorId);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params, opts.limit ?? 1000) as unknown as Row[];
  return rows.map(toDecision);
}

/** Pendientes de responder (sin contar las aplazadas): el número de la pestaña. */
export function countPending(at = new Date()): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM decisions WHERE status = 'pendiente' AND (postponed_until IS NULL OR postponed_until <= ?)")
    .get(at.toISOString()) as { n: number };
  return row.n;
}

function changed(d: Decision, kind: "created" | "updated" = "updated"): Decision {
  emit(`decision.${kind}`, { decision: d, pending: countPending() });
  return d;
}

// ───────────── Parecidos (para no repetir lo rechazado) ─────────────

const STOPWORDS = new Set(
  "de del la las el los un una unos unas y o u e a al en con por para sin sobre que se su sus mi mis tu tus lo le les como mas muy ya es son cada todo toda todos todas este esta estos estas ese esa".split(
    " ",
  ),
);

/** Palabras significativas de un texto (sin tildes, mayúsculas ni plurales simples). */
export function keywords(text: string): Set<string> {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es")
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
  return new Set(words);
}

/** Dos títulos hablan de lo mismo (solapamiento de palabras clave). */
export function isSimilar(a: string, b: string): boolean {
  const ka = keywords(a);
  const kb = keywords(b);
  if (!ka.size || !kb.size) return false;
  let common = 0;
  for (const w of ka) if (kb.has(w)) common++;
  const jaccard = common / (ka.size + kb.size - common);
  const min = Math.min(ka.size, kb.size);
  return jaccard >= 0.5 || (min >= 3 && common / min >= 0.8);
}

// ───────────── Crear ─────────────

export interface NewDecision {
  title: string;
  context?: string;
  options?: string[];
  approval?: boolean;
}

/** Máximo de decisiones pendientes por agente: que no se convierta en spam. */
export const MAX_PENDING_PER_AGENT = 8;

function cleanOptions(options: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of options ?? []) {
    const o = raw.trim();
    if (!o) continue;
    if (o.length > MAX_OPTION_LENGTH) throw new Error(`Opción demasiado larga (máx. ${MAX_OPTION_LENGTH} caracteres): «${o.slice(0, 30)}…».`);
    if (!out.some((x) => x.toLowerCase() === o.toLowerCase())) out.push(o);
  }
  if (out.length > MAX_OPTIONS) throw new Error(`Demasiadas opciones (máx. ${MAX_OPTIONS}).`);
  return out;
}

function insert(input: NewDecision, opts: { author: Agent | null; source?: string }): Decision {
  const title = input.title.trim();
  if (!title) throw new Error("La decisión necesita un título.");
  if (title.length > 140) throw new Error("Título demasiado largo (máx. 140 caracteres).");
  const context = (input.context ?? "").trim();
  if (context.length > 4000) throw new Error("Contexto demasiado largo (máx. 4000 caracteres): que sea un resumen corto.");
  const options = cleanOptions(input.options);
  const id = randomUUID();
  const at = now();
  getDb()
    .prepare(
      `INSERT INTO decisions (id, title, context, options, approval, author_id, author_name, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)`,
    )
    .run(id, title, context, JSON.stringify(options), input.approval ? 1 : 0, opts.author?.id ?? null, opts.author?.name ?? "", opts.source ?? null, at, at);
  return getDecision(id)!;
}

/**
 * Decisión nueva de un agente. Se niega si se parece a una que el usuario ya
 * rechazó (y devuelve el motivo, para aprender), si ya hay una igual
 * pendiente o si el agente tiene demasiadas pendientes.
 */
export function createDecision(input: NewDecision, author: Agent | null): Decision {
  const resolved = listDecisions({ statuses: ["resuelta"] });
  const rejected = resolved.find((d) => d.answerKind === "rechazar" && isSimilar(d.title, input.title));
  if (rejected) {
    throw new Error(
      `El usuario ya rechazó algo igual: «${rejected.title}»${rejected.answer ? ` (motivo: ${rejected.answer})` : " (sin motivo)"}. No la vuelvas a plantear; si de verdad es distinta, cambia el enfoque y el título.`,
    );
  }
  const pending = listDecisions({ statuses: ["pendiente"] });
  const open = pending.find((d) => isSimilar(d.title, input.title));
  if (open) throw new Error(`Ya hay una decisión parecida pendiente: «${open.title}» (id ${open.id.slice(0, 8)}).`);
  if (author && pending.filter((d) => d.authorId === author.id).length >= MAX_PENDING_PER_AGENT) {
    throw new Error(`Ya tienes ${MAX_PENDING_PER_AGENT} decisiones pendientes: espera a que el usuario responda o retira alguna con decision_retirar.`);
  }
  const d = insert(input, { author });
  logActivity("decisiones", `${author?.name ?? "Alguien"} pregunta: «${d.title}»`, author?.id ?? null, { decisionId: d.id });
  return changed(d, "created");
}

// ───────────── Respuestas del usuario ─────────────

function setFields(id: string, fields: Record<string, string | null>) {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE decisions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), now(), id);
}

export interface UserAnswer {
  /** responder = texto libre y/u opción elegida. */
  action: "responder" | "aceptar" | "rechazar";
  /** Texto escrito por el usuario (comentario o motivo). */
  text?: string;
  /** Opción sugerida elegida. */
  option?: string;
  /** Capturas o archivos que adjunta al responder. */
  attachments?: AttachmentRef[];
}

/** Normaliza la respuesta: qué tipo es y qué texto se guarda. */
export function normalizeAnswer(d: Decision, a: UserAnswer): { kind: AnswerKind; answer: string | null } {
  const text = a.text?.trim().slice(0, MAX_ANSWER_LENGTH) || null;
  if (a.action === "aceptar") return { kind: "aceptar", answer: text };
  if (a.action === "rechazar") return { kind: "rechazar", answer: text };
  if (a.action !== "responder") throw new Error("Respuesta desconocida.");
  const option = a.option?.trim();
  if (option) {
    if (!d.options.includes(option)) throw new Error("Esa opción no está entre las sugeridas.");
    return { kind: "opcion", answer: text ? `${option} — ${text}` : option };
  }
  if (!text && a.attachments?.length) return { kind: "texto", answer: "(Respuesta en los adjuntos)" };
  if (!text) throw new Error("Escribe una respuesta o elige una opción.");
  return { kind: "texto", answer: text };
}

/** El usuario responde: la decisión pasa a «resuelta» y la respuesta llega al agente. */
export function answerDecision(id: string, a: UserAnswer, opts: { at?: Date } = {}): Decision {
  const d = getDecision(id);
  if (!d) throw new Error("Esa decisión no existe.");
  if (d.status !== "pendiente") throw new Error("Esta decisión ya está resuelta.");
  const { kind, answer } = normalizeAnswer(d, a);
  const at = (opts.at ?? new Date()).toISOString();
  tx(() => {
    setFields(id, { status: "resuelta", answer_kind: kind, answer, resolved_at: at, postponed_until: null, task_id: null, attachments: JSON.stringify(a.attachments ?? []) });
    logActivity("decisiones", `Decisión resuelta: «${d.title}» · ${kind === "opcion" || kind === "texto" ? answer : kind}`, null, { decisionId: id });
  });
  dispatchAnswered();
  return changed(getDecision(id)!);
}

/** Aplazar: sigue pendiente, pero no cuenta ni se muestra arriba hasta esa fecha. */
export function postponeDecision(id: string, days: number, opts: { at?: Date } = {}): Decision {
  const d = getDecision(id);
  if (!d) throw new Error("Esa decisión no existe.");
  if (d.status !== "pendiente") throw new Error("Esta decisión ya está resuelta.");
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Aplaza entre 1 y 365 días.");
  const until = new Date((opts.at ?? new Date()).getTime() + days * 86_400_000).toISOString();
  setFields(id, { postponed_until: until });
  logActivity("decisiones", `Decisión aplazada ${days} día${days === 1 ? "" : "s"}: «${d.title}»`, null, { decisionId: id });
  return changed(getDecision(id)!);
}

/** Vuelve a dejar pendiente una resuelta (p. ej. si el usuario cambia de idea). */
export function reopenDecision(id: string): Decision {
  const d = getDecision(id);
  if (!d) throw new Error("Esa decisión no existe.");
  if (d.status !== "resuelta") throw new Error("Solo se puede reabrir una decisión resuelta.");
  setFields(id, { status: "pendiente", answer_kind: null, answer: null, resolved_at: null, postponed_until: null, task_id: null, attachments: "[]" });
  logActivity("decisiones", `Decisión reabierta: «${d.title}»`, null, { decisionId: id });
  return changed(getDecision(id)!);
}

/** El agente la retira porque ya no hace falta (no se avisa a nadie). */
export function withdrawDecision(id: string, by: Agent | null): Decision {
  const d = getDecision(id);
  if (!d) throw new Error("Esa decisión no existe.");
  if (d.status !== "pendiente") throw new Error("Esta decisión ya está resuelta.");
  if (by && !by.isChief && d.authorId && d.authorId !== by.id) throw new Error("Solo puede retirarla quien la planteó (o el jefe).");
  setFields(id, { status: "resuelta", answer_kind: "retirada", answer: null, resolved_at: now(), postponed_until: null });
  logActivity("decisiones", `Decisión retirada: «${d.title}»`, by?.id ?? null, { decisionId: id });
  return changed(getDecision(id)!);
}

/** Lo que dice la decisión, ya resuelta, en una línea. */
export function verdictOf(d: Decision): string {
  switch (d.answerKind) {
    case "aceptar":
      return `ACEPTADA${d.answer ? `. Comentario: ${d.answer}` : ""}`;
    case "rechazar":
      return `RECHAZADA${d.answer ? `. Motivo: ${d.answer}` : " (sin motivo)"}`;
    case "opcion":
      return `ha elegido «${d.answer}»`;
    case "texto":
      return `«${d.answer}»`;
    default:
      return "(sin respuesta)";
  }
}

/** Mensaje que recibe el agente cuando el usuario responde. */
export function answerPrompt(d: Decision): string {
  const next =
    d.answerKind === "aceptar"
      ? "Adelante: ejecútala ahora con tus herramientas (delega lo que no sea de tu especialidad). Al terminar, responde con un resumen breve de lo hecho y dónde verlo."
      : d.answerKind === "rechazar"
        ? "No la ejecutes ni la vuelvas a plantear. Si el motivo revela una preferencia duradera, guárdala en memoria. Responde en una línea."
        : "Sigue con lo que tenías pendiente usando esta respuesta. Responde con un resumen breve de lo que haces.";
  return [
    `El usuario ha respondido a tu decisión «${d.title}» (id ${d.id.slice(0, 8)}) en la pestaña «${TAB_LABEL}».`,
    `Respuesta: ${verdictOf(d)}`,
    d.context ? `\nLo que planteaste:\n${d.context}` : "",
    `\n${next}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Quién recibe la respuesta: el autor si sigue en el equipo; si no, el jefe. */
function recipientOf(d: Decision): Agent | null {
  return (d.authorId && getAgent(d.authorId)) || getChief();
}

/**
 * Envía al agente cada respuesta todavía sin avisar. Idempotente (cada
 * respuesta, una vez) y seguro entre procesos: lo llaman la web al responder
 * y el worker en cada vuelta, como red.
 */
export function dispatchAnswered(): Decision[] {
  return tx(() => {
    const out: Decision[] = [];
    const rows = getDb()
      .prepare("SELECT * FROM decisions WHERE status = 'resuelta' AND task_id IS NULL AND answer_kind IN ('aceptar', 'rechazar', 'opcion', 'texto') ORDER BY resolved_at")
      .all() as unknown as Row[];
    for (const d of rows.map(toDecision)) {
      const agent = recipientOf(d);
      if (!agent) continue;
      const conv = activeConversation(agent.id);
      const task = createTask({
        agentId: agent.id,
        kind: "chat",
        conversationId: conv.id,
        title: `Decisión respondida: ${d.title}`,
        prompt: answerPrompt(d),
        createdBy: "user",
        data: { decisionId: d.id, ...(d.attachments.length && { attachments: d.attachments }) },
      });
      addMessage({
        conversationId: conv.id,
        role: "user",
        content: `**Decisión «${d.title}»:** ${verdictOf(d)}`,
        taskId: task.id,
        data: { kind: "decision", decisionId: d.id, ...(d.attachments.length && { attachments: d.attachments }) },
      });
      setFields(d.id, { task_id: task.id });
      out.push(getDecision(d.id)!);
    }
    return out;
  });
}

/** Nombre del autor (o del agente si sigue existiendo y cambió de nombre). */
export function authorOf(d: Decision): string {
  return (d.authorId && getAgent(d.authorId)?.name) || d.authorName || "Equipo";
}
