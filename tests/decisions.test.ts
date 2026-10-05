import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { migrations } from "@/lib/db/migrations";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { listMessages } from "@/lib/repo/chat";
import { createTask, getTask } from "@/lib/repo/tasks";
import { eventsAfter } from "@/lib/events";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildContext, buildSystemPrompt } from "@/lib/agents/prompt";
import "@/lib/agents/modules";
import {
  answerDecision,
  answerLabel,
  answerPrompt,
  countPending,
  createDecision,
  dispatchAnswered,
  findDecision,
  getDecision,
  isSimilar,
  keywords,
  listDecisions,
  MAX_PENDING_PER_AGENT,
  postponeDecision,
  reopenDecision,
  TAB_LABEL,
  viewOf,
  withdrawDecision,
} from "@/lib/decisions/repo";
import { decisionsContext, listForAgent } from "@/lib/decisions/tools";
import type { Agent } from "@/lib/types";

let zen: Agent;
let ana: Agent;

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  zen = getChief()!;
  ana = hireAgent({ name: "Ana", specialty: "Finanzas personales" });
});

function toolsOf(agent: Agent, kind: "chat" | "ambient" = "chat"): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind, prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}
async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  return (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
}

describe("pestaña", () => {
  it("se llama «Decisiones»", () => {
    expect(TAB_LABEL).toBe("Decisiones");
  });
});

describe("parecidos", () => {
  it("palabras clave sin tildes, plurales simples ni palabras vacías", () => {
    expect([...keywords("Revisión de las suscripciones")]).toEqual(["revision", "suscripcion"]);
  });
  it("detecta el mismo tema con otras palabras", () => {
    expect(isSimilar("Revisión mensual de suscripciones", "Revisar suscripciones: revisión mensual")).toBe(true);
    expect(isSimilar("Panel de hábitos y salud", "Plan trimestral del trabajo")).toBe(false);
  });
});

describe("crear", () => {
  it("crea una pendiente con opciones limpias y cuenta en la pestaña", () => {
    const d = createDecision({ title: "¿Qué día prefieres para la revisión?", context: "Para el calendario.", options: [" Lunes ", "Martes", "lunes", ""] }, ana);
    expect(d).toMatchObject({ status: "pendiente", options: ["Lunes", "Martes"], approval: false, authorId: ana.id, authorName: "Ana", answer: null });
    expect(countPending()).toBe(1);
    expect(findDecision(d.id.slice(0, 8))?.id).toBe(d.id);
  });

  it("valida título, contexto y opciones", () => {
    expect(() => createDecision({ title: "   " }, zen)).toThrow(/título/);
    expect(() => createDecision({ title: "x".repeat(141) }, zen)).toThrow(/largo/);
    expect(() => createDecision({ title: "Opciones", options: ["a", "b", "c", "d", "e", "f", "g"] }, zen)).toThrow(/opciones/);
    expect(() => createDecision({ title: "Opción larga", options: ["x".repeat(81)] }, zen)).toThrow(/larga/);
  });

  it("no deja repetir lo rechazado (y da el motivo) ni duplicar lo pendiente", () => {
    const d = createDecision({ title: "Revisión mensual de suscripciones", approval: true }, zen);
    answerDecision(d.id, { action: "rechazar", text: "Lo hace mi banco" });
    expect(() => createDecision({ title: "Revisar las suscripciones: revisión mensual" }, zen)).toThrow(/Lo hace mi banco/);
    createDecision({ title: "Panel de hábitos y salud" }, zen);
    expect(() => createDecision({ title: "Panel de hábitos de salud" }, ana)).toThrow(/parecida pendiente/);
  });

  it("limita las pendientes por agente", () => {
    const topics = ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
    for (const t of topics.slice(0, MAX_PENDING_PER_AGENT)) createDecision({ title: t }, ana);
    expect(() => createDecision({ title: topics[MAX_PENDING_PER_AGENT] }, ana)).toThrow(/pendientes/);
  });
});

describe("responder", () => {
  it("aceptar la resuelve y la respuesta llega al autor una sola vez, como mensaje en su chat", () => {
    const d = createDecision({ title: "Crear panel de presupuesto", context: "Un panel con gastos fijos.", approval: true }, ana);
    const r = answerDecision(d.id, { action: "aceptar", text: "  Sí, empieza por los fijos  " });
    expect(r).toMatchObject({ status: "resuelta", answerKind: "aceptar", answer: "Sí, empieza por los fijos" });
    expect(r.taskId).not.toBeNull();
    expect(countPending()).toBe(0);
    const task = getTask(r.taskId!)!;
    expect(task).toMatchObject({ agentId: ana.id, kind: "chat", status: "queued", createdBy: "user" });
    expect(task.prompt).toContain("Crear panel de presupuesto");
    expect(task.prompt).toContain("ACEPTADA");
    expect(task.prompt).toContain("Sí, empieza por los fijos");
    expect(listMessages(task.conversationId!).some((m) => m.role === "user" && m.content.includes("ACEPTADA"))).toBe(true);
    expect(dispatchAnswered()).toHaveLength(0);
  });

  it("opción sugerida y texto libre", () => {
    const a = createDecision({ title: "Día de la revisión", options: ["Lunes", "Martes"] }, ana);
    expect(() => answerDecision(a.id, { action: "responder", option: "Jueves" })).toThrow(/sugeridas/);
    expect(() => answerDecision(a.id, { action: "responder" })).toThrow(/Escribe/);
    expect(answerDecision(a.id, { action: "responder", option: "Martes", text: "por la tarde" })).toMatchObject({ answerKind: "opcion", answer: "Martes — por la tarde" });
    const b = createDecision({ title: "Usuario del banco" }, ana);
    const rb = answerDecision(b.id, { action: "responder", text: "Lo subo a Archivos" });
    expect(rb).toMatchObject({ answerKind: "texto", answer: "Lo subo a Archivos" });
    expect(answerLabel(rb)).toBe("Respondiste: Lo subo a Archivos");
    expect(() => answerDecision(b.id, { action: "responder", text: "otra" })).toThrow(/resuelta/);
  });

  it("si el autor ya no está, la respuesta va al jefe", () => {
    const d = createDecision({ title: "Pregunta huérfana" }, null);
    const r = answerDecision(d.id, { action: "responder", text: "Hecho" });
    expect(getTask(r.taskId!)!.agentId).toBe(zen.id);
  });

  it("rechazar sin motivo también avisa y el prompt pide no repetirla", () => {
    const d = createDecision({ title: "Gimnasio tres días", approval: true }, zen);
    const r = answerDecision(d.id, { action: "rechazar" });
    expect(answerPrompt(r)).toContain("RECHAZADA (sin motivo)");
    expect(answerPrompt(r)).toContain("No la ejecutes");
  });

  it("aplazar la saca del contador hasta su fecha", () => {
    const at = new Date("2026-10-04T10:00:00Z");
    const d = createDecision({ title: "Presupuesto mensual" }, zen);
    postponeDecision(d.id, 7, { at });
    const q = getDecision(d.id)!;
    expect(q.postponedUntil).toBe("2026-10-11T10:00:00.000Z");
    expect(countPending(new Date("2026-10-05T00:00:00Z"))).toBe(0);
    expect(countPending(new Date("2026-10-12T00:00:00Z"))).toBe(1);
    expect(viewOf(q, new Date("2026-10-05T00:00:00Z"))).toBe("aplazadas");
    expect(viewOf(q, new Date("2026-10-12T00:00:00Z"))).toBe("pendientes");
    expect(() => postponeDecision(d.id, 0)).toThrow(/1 y 365/);
  });

  it("reabrir la deja pendiente y una nueva respuesta vuelve a avisar", () => {
    const d = createDecision({ title: "Color del panel" }, ana);
    const first = answerDecision(d.id, { action: "responder", text: "Azul" });
    const reopened = reopenDecision(d.id);
    expect(reopened).toMatchObject({ status: "pendiente", answer: null, answerKind: null, taskId: null });
    const second = answerDecision(d.id, { action: "responder", text: "Verde" });
    expect(second.taskId).not.toBe(first.taskId);
    expect(() => reopenDecision(createDecision({ title: "Otra cosa distinta" }, ana).id)).toThrow(/resuelta/);
  });

  it("retirar: solo el autor o el jefe, y no avisa a nadie", () => {
    const d = createDecision({ title: "Ya no hace falta" }, ana);
    const otro = hireAgent({ name: "Luis", specialty: "Salud" });
    expect(() => withdrawDecision(d.id, otro)).toThrow(/quien la planteó/);
    const r = withdrawDecision(d.id, zen);
    expect(r).toMatchObject({ status: "resuelta", answerKind: "retirada", taskId: null });
    expect(dispatchAnswered()).toHaveLength(0);
  });

  it("cada cambio emite el contador de pendientes", () => {
    const d = createDecision({ title: "Presupuesto mensual" }, zen);
    createDecision({ title: "Panel de hábitos" }, zen);
    answerDecision(d.id, { action: "aceptar" });
    const last = eventsAfter(0).filter((e) => e.type.startsWith("decision.")).at(-1)!;
    expect(last.type).toBe("decision.updated");
    expect((last.payload as { pending: number }).pending).toBe(1);
  });
});

describe("herramientas", () => {
  const names = (a: Agent, kind: "chat" | "ambient" = "chat") =>
    toolsOf(a, kind)
      .map((t) => t.name)
      .filter((n) => n.startsWith("decision"))
      .sort();

  it("todos pueden plantear, listar y retirar; nadie en tareas de ambiente", () => {
    expect(names(zen)).toEqual(["decision_crear", "decision_retirar", "decisiones_listar"]);
    expect(names(ana)).toEqual(["decision_crear", "decision_retirar", "decisiones_listar"]);
    expect(names(zen, "ambient")).toEqual([]);
  });

  it("decision_crear, decisiones_listar y decision_retirar de punta a punta", async () => {
    const r = await call(ana, "decision_crear", { titulo: "¿Conecto tu banco?", contexto: "Solo lectura.", opciones: ["Sí", "Más adelante"] });
    expect(r.isError).toBeFalsy();
    const d = listDecisions()[0];
    expect(d.options).toEqual(["Sí", "Más adelante"]);
    const list = await call(ana, "decisiones_listar", { estado: "pendiente", solo_mias: true });
    expect(list.content[0].text).toContain("¿Conecto tu banco?");
    expect(list.content[0].text).toContain("opciones: Sí | Más adelante");
    const ret = await call(ana, "decision_retirar", { id: d.id.slice(0, 8) });
    expect(ret.isError).toBeFalsy();
    expect(listForAgent("pendiente")).toBe("No hay decisiones con ese filtro.");
    expect(listForAgent("resuelta")).toContain("Retirada por el agente");
  });

  it("el contexto muestra lo pendiente propio (todo, al jefe) y lo rechazado con su motivo", () => {
    expect(decisionsContext(zen)).toBeNull();
    createDecision({ title: "Pregunta de Ana" }, ana);
    const b = createDecision({ title: "Gimnasio tres días", approval: true }, zen);
    answerDecision(b.id, { action: "rechazar", text: "Prefiero correr" });
    const ctx = buildContext(zen, createTask({ agentId: zen.id, kind: "chat", prompt: "x" }));
    expect(ctx).toContain("Pregunta de Ana");
    expect(ctx).toContain("motivo: Prefiero correr");
    const anaCtx = decisionsContext(ana)!;
    expect(anaCtx).toContain("Pregunta de Ana");
    expect(anaCtx).not.toContain("Gimnasio");
    const prompt = buildSystemPrompt(zen, createTask({ agentId: zen.id, kind: "chat", prompt: "x" }));
    expect(prompt).toContain("decision_crear");
    expect(prompt).toContain("propuesta_crear → decision_crear");
  });
});

describe("migración de propuestas y del panel «Acción humana»", () => {
  function dbAt(version: number): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    for (const m of migrations.filter((x) => x.version <= version)) m.up(db);
    return db;
  }

  it("pendientes → pendientes; decididas → resueltas sin reenviar; lista → decisiones del jefe", () => {
    const db = dbAt(14);
    const ts = "2026-10-01T10:00:00.000Z";
    db.prepare("INSERT INTO agents (id, name, is_chief, created_at, updated_at) VALUES ('z', 'Zen', 1, ?, ?)").run(ts, ts);
    const ins = db.prepare(
      `INSERT INTO proposals (id, title, description, scope, priority, impact, effort, author_id, author_name, status, reject_reason, postponed_until, task_id, created_at, updated_at, decided_at)
       VALUES (?, ?, 'desc', 'app', 'media', 'medio', 'medio', 'z', 'Zen', ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("p1", "Pendiente", "pendiente", null, "2026-10-09T00:00:00.000Z", null, ts, ts, null);
    ins.run("p2", "Rechazada", "rechazada", "No me interesa", null, null, ts, ts, ts);
    ins.run("p3", "Hecha", "hecha", null, null, "t-viejo", ts, ts, ts);
    const items = [
      { id: "i1", text: "Sube el PDF del seguro", done: false, notes: "A Archivos" },
      { id: "i2", text: "Ya hecho", done: true },
    ];
    db.prepare("INSERT INTO panels (id, type, title, data, created_at, updated_at) VALUES ('pa', 'lista', 'ACCION HUMANA · lo que necesito de ti', ?, ?, ?)").run(
      JSON.stringify({ items, checkable: true }),
      ts,
      ts,
    );
    migrations.find((m) => m.version === 15)!.up(db);
    const rows = db.prepare("SELECT * FROM decisions ORDER BY title").all() as Record<string, unknown>[];
    const by = (t: string) => rows.find((r) => r.title === t)!;
    expect(rows).toHaveLength(4);
    expect(by("Pendiente")).toMatchObject({ status: "pendiente", approval: 1, context: "desc", postponed_until: "2026-10-09T00:00:00.000Z", task_id: null });
    expect(by("Rechazada")).toMatchObject({ status: "resuelta", answer_kind: "rechazar", answer: "No me interesa", task_id: "migrada" });
    expect(by("Hecha")).toMatchObject({ status: "resuelta", answer_kind: "aceptar", task_id: "t-viejo" });
    expect(by("Sube el PDF del seguro")).toMatchObject({ status: "pendiente", approval: 0, context: "A Archivos", author_id: "z", author_name: "Zen" });
    // El panel sigue intacto.
    expect(JSON.parse((db.prepare("SELECT data FROM panels WHERE id = 'pa'").get() as { data: string }).data).items).toHaveLength(2);
  });
});
