import { randomUUID } from "node:crypto";
import { getDb, now, tx } from "../db";
import { emit } from "../events";
import { getAgent, getChief } from "../repo/agents";
import { activeConversation, addMessage } from "../repo/chat";
import { createTask } from "../repo/tasks";
import { logActivity } from "../repo/system";
import type { Agent } from "../types";
import {
  LEVELS,
  PRIORITIES,
  SCOPE_KEYS,
  SCOPES,
  STATUS_LABEL,
  type Decision,
  type Proposal,
  type ProposalLevel,
  type ProposalPriority,
  type ProposalScope,
  type ProposalStatus,
} from "./labels";

export * from "./labels";

/**
 * Propuestas: ideas de los agentes (sobre todo Zen) que el usuario acepta,
 * rechaza o aplaza desde la pestaña «Propuestas». Al aceptar, Zen recibe un
 * encargo para ejecutarla; lo rechazado (con su motivo) no se vuelve a proponer.
 */

interface Row {
  id: string;
  title: string;
  description: string;
  scope: string;
  priority: string;
  impact: string;
  effort: string;
  author_id: string | null;
  author_name: string;
  status: string;
  reject_reason: string | null;
  result_note: string | null;
  postponed_until: string | null;
  task_id: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  finished_at: string | null;
}

function toProposal(r: Row): Proposal {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    scope: (r.scope in SCOPES ? r.scope : "otros") as ProposalScope,
    priority: r.priority as ProposalPriority,
    impact: r.impact as ProposalLevel,
    effort: r.effort as ProposalLevel,
    authorId: r.author_id,
    authorName: r.author_name,
    status: r.status as ProposalStatus,
    rejectReason: r.reject_reason,
    resultNote: r.result_note,
    postponedUntil: r.postponed_until,
    taskId: r.task_id,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedAt: r.decided_at,
    finishedAt: r.finished_at,
  };
}

export function getProposal(id: string): Proposal | null {
  const row = getDb().prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toProposal(row) : null;
}

/** Por id completo o por sus primeros caracteres (mín. 6), como los ids cortos de las herramientas. */
export function findProposal(ref: string): Proposal | null {
  const r = ref.trim();
  const exact = getProposal(r);
  if (exact) return exact;
  if (r.length < 6 || !/^[0-9a-f-]+$/i.test(r)) return null;
  const rows = getDb().prepare("SELECT * FROM proposals WHERE id LIKE ? LIMIT 2").all(`${r.toLowerCase()}%`) as unknown as Row[];
  return rows.length === 1 ? toProposal(rows[0]) : null;
}

export function listProposals(opts: { statuses?: ProposalStatus[]; limit?: number } = {}): Proposal[] {
  const where = opts.statuses?.length ? `WHERE status IN (${opts.statuses.map(() => "?").join(",")})` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM proposals ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...(opts.statuses ?? []), opts.limit ?? 1000) as unknown as Row[];
  return rows.map(toProposal);
}

/** Pendientes de decidir (sin contar las aplazadas): el número de la pestaña. */
export function countPending(at = new Date()): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pendiente' AND (postponed_until IS NULL OR postponed_until <= ?)")
    .get(at.toISOString()) as { n: number };
  return row.n;
}

function changed(p: Proposal, kind: "created" | "updated" = "updated"): Proposal {
  emit(`proposal.${kind}`, { proposal: p, pending: countPending() });
  return p;
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

/** La propuesta rechazada (o abierta) más parecida a un título, si la hay. */
export function findSimilar(title: string, statuses: ProposalStatus[]): Proposal | null {
  return listProposals({ statuses }).find((p) => isSimilar(p.title, title)) ?? null;
}

// ───────────── Crear ─────────────

export interface NewProposal {
  title: string;
  description?: string;
  scope: ProposalScope;
  priority: ProposalPriority;
  impact: ProposalLevel;
  effort: ProposalLevel;
}

function check<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${what} no válido: «${value}». Opciones: ${allowed.join(", ")}.`);
  return value as T;
}

function insert(input: NewProposal, opts: { author: Agent | null; status?: ProposalStatus; source?: string; createdAt?: string; decidedAt?: string | null }): Proposal {
  const title = input.title.trim();
  if (!title) throw new Error("La propuesta necesita un título.");
  if (title.length > 140) throw new Error("Título demasiado largo (máx. 140 caracteres).");
  const description = (input.description ?? "").trim();
  if (description.length > 4000) throw new Error("Descripción demasiado larga (máx. 4000 caracteres): que sea un resumen corto.");
  check(input.scope, SCOPE_KEYS, "Ámbito");
  check(input.priority, PRIORITIES, "Prioridad");
  check(input.impact, LEVELS, "Impacto");
  check(input.effort, LEVELS, "Esfuerzo");
  const id = randomUUID();
  const at = now();
  getDb()
    .prepare(
      `INSERT INTO proposals (id, title, description, scope, priority, impact, effort, author_id, author_name, status, source, created_at, updated_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      description,
      input.scope,
      input.priority,
      input.impact,
      input.effort,
      opts.author?.id ?? null,
      opts.author?.name ?? "",
      opts.status ?? "pendiente",
      opts.source ?? null,
      opts.createdAt ?? at,
      at,
      opts.decidedAt ?? null,
    );
  return getProposal(id)!;
}

/**
 * Propuesta nueva de un agente. Se niega si se parece a una rechazada (y
 * devuelve el motivo, para aprender) o a una que sigue abierta.
 */
export function createProposal(input: NewProposal, author: Agent | null): Proposal {
  const rejected = findSimilar(input.title, ["rechazada"]);
  if (rejected) {
    throw new Error(
      `El usuario ya rechazó algo igual: «${rejected.title}»${rejected.rejectReason ? ` (motivo: ${rejected.rejectReason})` : " (sin motivo)"}. No la vuelvas a proponer; si de verdad es distinta, cambia el enfoque y el título.`,
    );
  }
  const open = findSimilar(input.title, ["pendiente", "aceptada", "en_curso"]);
  if (open) throw new Error(`Ya hay una propuesta parecida ${STATUS_LABEL[open.status].toLowerCase()}: «${open.title}» (id ${open.id.slice(0, 8)}).`);
  const p = insert(input, { author });
  logActivity("propuestas", `${author?.name ?? "Alguien"} propone «${p.title}»`, author?.id ?? null, { proposalId: p.id });
  return changed(p, "created");
}

// ───────────── Decisiones del usuario ─────────────


function setFields(id: string, fields: Record<string, string | null>) {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE proposals SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), now(), id);
}

/** Lo que decide el usuario desde la pestaña. */
export function decideProposal(id: string, decision: Decision, opts: { reason?: string; days?: number; at?: Date } = {}): Proposal {
  const p = getProposal(id);
  if (!p) throw new Error("Esa propuesta no existe.");
  const at = opts.at ?? new Date();
  if (decision === "reabrir") {
    if (p.status !== "rechazada") throw new Error("Solo se puede recuperar una propuesta rechazada.");
    setFields(id, { status: "pendiente", reject_reason: null, decided_at: null, postponed_until: null });
    logActivity("propuestas", `Propuesta recuperada: «${p.title}»`, null, { proposalId: id });
    return changed(getProposal(id)!);
  }
  if (p.status !== "pendiente") throw new Error(`Esta propuesta ya está ${STATUS_LABEL[p.status].toLowerCase()}.`);
  if (decision === "aceptar") {
    setFields(id, { status: "aceptada", decided_at: at.toISOString(), postponed_until: null });
    logActivity("propuestas", `Propuesta aceptada: «${p.title}» (Zen la ejecutará)`, null, { proposalId: id });
  } else if (decision === "rechazar") {
    const reason = opts.reason?.trim().slice(0, 500) || null;
    setFields(id, { status: "rechazada", reject_reason: reason, decided_at: at.toISOString(), postponed_until: null });
    logActivity("propuestas", `Propuesta rechazada: «${p.title}»${reason ? ` · ${reason}` : ""}`, null, { proposalId: id });
  } else if (decision === "aplazar") {
    const days = opts.days ?? 7;
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Aplaza entre 1 y 365 días.");
    const until = new Date(at.getTime() + days * 86_400_000).toISOString();
    setFields(id, { postponed_until: until });
    logActivity("propuestas", `Propuesta aplazada ${days} día${days === 1 ? "" : "s"}: «${p.title}»`, null, { proposalId: id });
  } else throw new Error("Decisión desconocida.");
  return changed(getProposal(id)!);
}

// ───────────── Avance (Zen) ─────────────

/** Zen marca una aceptada «en curso» o «hecha», con una nota de resultado. */
export function advanceProposal(id: string, status: "en_curso" | "hecha", note: string | undefined, by: Agent | null): Proposal {
  const p = getProposal(id);
  if (!p) throw new Error("Esa propuesta no existe.");
  const allowed: ProposalStatus[] = ["aceptada", "en_curso"];
  if (!allowed.includes(p.status)) {
    throw new Error(
      p.status === "pendiente"
        ? "El usuario aún no la ha aceptado: no la ejecutes hasta que la acepte."
        : `No se puede pasar de «${STATUS_LABEL[p.status]}» a «${STATUS_LABEL[status]}».`,
    );
  }
  const text = note?.trim().slice(0, 4000) || null;
  setFields(id, {
    status,
    result_note: text ?? p.resultNote,
    finished_at: status === "hecha" ? now() : null,
  });
  logActivity("propuestas", `«${p.title}» → ${STATUS_LABEL[status].toLowerCase()}${text ? ` · ${text.slice(0, 120)}` : ""}`, by?.id ?? null, { proposalId: id });
  return changed(getProposal(id)!);
}

// ───────────── Aviso a Zen ─────────────

export function executionPrompt(p: Proposal): string {
  return `El usuario ha ACEPTADO tu propuesta «${p.title}» (id ${p.id.slice(0, 8)}) en la pestaña «Acción humana».
Ámbito: ${SCOPES[p.scope]} · prioridad ${p.priority} · impacto ${p.impact} · esfuerzo ${p.effort}.

${p.description || "(sin descripción)"}

Tienes permisos completos para ejecutarla (salvo borrar datos). Pasos:
1. Márcala «en_curso» con propuesta_actualizar.
2. Ejecútala tú o delega en quien corresponda.
3. Al terminar, márcala «hecha» con una nota de resultado breve (qué se hizo y dónde verlo). Si algo depende del usuario (p. ej. pulsar Aplicar), dilo en la nota.`;
}

/**
 * Crea un encargo para Zen por cada propuesta aceptada sin avisar. Idempotente
 * (cada propuesta, una vez) y seguro entre procesos: lo llaman la web al
 * aceptar y el worker en cada vuelta.
 */
export function dispatchAccepted(): Proposal[] {
  const chief = getChief();
  if (!chief) return [];
  return tx(() => {
    const out: Proposal[] = [];
    for (const p of listProposals({ statuses: ["aceptada"] })) {
      if (p.taskId) continue;
      const conv = activeConversation(chief.id);
      const task = createTask({
        agentId: chief.id,
        kind: "delegation",
        conversationId: conv.id,
        title: `Propuesta aceptada: ${p.title}`,
        prompt: executionPrompt(p),
        createdBy: "user",
        data: { proposalId: p.id },
      });
      addMessage({
        conversationId: conv.id,
        role: "tool",
        content: `✅ El usuario ha aceptado la propuesta «${p.title}»: a ejecutarla.`,
        agentId: chief.id,
        taskId: task.id,
        data: { kind: "proposal", proposalId: p.id },
      });
      setFields(p.id, { task_id: task.id });
      out.push(changed(getProposal(p.id)!));
    }
    return out;
  });
}

// ───────────── Importar un kanban de propuestas ─────────────

/** Columna del kanban → estado. */
export function statusFromColumn(title: string): ProposalStatus {
  const t = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (/aprobad|aceptad/.test(t)) return "aceptada";
  if (/curso|haciendo/.test(t)) return "en_curso";
  if (/hech|terminad|complet/.test(t)) return "hecha";
  if (/descartad|rechazad/.test(t)) return "rechazada";
  return "pendiente";
}

const TAG_SCOPE: Record<string, ProposalScope> = {
  conexiones: "conexiones",
  conexion: "conexiones",
  agentes: "agentes",
  salas: "agentes",
  equipo: "agentes",
  casa: "casa",
  hogar: "casa",
  trabajo: "trabajo",
  empresa: "trabajo",
  finanzas: "finanzas",
  dinero: "finanzas",
  salud: "salud",
  aprendizaje: "aprendizaje",
  estudio: "aprendizaje",
  agenda: "agenda",
  calendario: "agenda",
  app: "app",
  orden: "app",
};

export function scopeFromTags(tags: string[] | undefined): ProposalScope {
  for (const tag of tags ?? []) {
    const k = tag
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
    if (TAG_SCOPE[k]) return TAG_SCOPE[k];
  }
  return "otros";
}

interface KanbanLike {
  columns: { id: string; title: string; cards: { id: string; title: string; notes?: string; tags?: string[]; priority?: string }[] }[];
}

/**
 * Copia las tarjetas de un kanban como propuestas (una vez por tarjeta; el
 * panel no se toca). La columna decide el estado («Aprobada» → aceptada).
 * Devuelve cuántas ha importado.
 */
export function importKanban(panelId: string, data: KanbanLike, opts: { author: Agent | null; createdAt?: string }): number {
  let n = 0;
  tx(() => {
    for (const col of data.columns) {
      const status = statusFromColumn(col.title);
      for (const card of col.cards) {
        const source = `kanban:${panelId}:${card.id}`;
        if (getDb().prepare("SELECT 1 FROM proposals WHERE source = ?").get(source)) continue;
        const priority = (PRIORITIES as readonly string[]).includes(card.priority ?? "") ? (card.priority as ProposalPriority) : "media";
        insert(
          { title: card.title.slice(0, 140), description: card.notes ?? "", scope: scopeFromTags(card.tags), priority, impact: "medio", effort: "medio" },
          { author: opts.author, status, source, createdAt: opts.createdAt, decidedAt: status === "pendiente" ? null : now() },
        );
        n++;
      }
    }
  });
  return n;
}

/** Nombre del autor (o del agente si sigue existiendo y cambió de nombre). */
export function authorOf(p: Proposal): string {
  return (p.authorId && getAgent(p.authorId)?.name) || p.authorName || "Usuario";
}
