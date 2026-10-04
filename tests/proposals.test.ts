import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createPanel, getPanel } from "@/lib/repo/panels";
import { createTask, getTask, listTasks } from "@/lib/repo/tasks";
import { eventsAfter } from "@/lib/events";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildContext, buildSystemPrompt } from "@/lib/agents/prompt";
import "@/lib/agents/modules";
import {
  advanceProposal,
  byPriority,
  countPending,
  createProposal,
  decideProposal,
  dispatchAccepted,
  findProposal,
  getProposal,
  importKanban,
  isSimilar,
  keywords,
  listProposals,
  scopeFromTags,
  statusFromColumn,
  viewOf,
  type NewProposal,
} from "@/lib/proposals/repo";
import { chiefProposalsContext, listForAgent } from "@/lib/proposals/tools";
import { findHumanActionPanel, TAB_LABEL } from "@/lib/proposals/labels";

describe("pestaña «Acción humana»", () => {
  const p = (type: string, title: string) => ({ type, title });

  it("se llama «Acción humana»", () => {
    expect(TAB_LABEL).toBe("Acción humana");
  });

  it("encuentra el panel de lista por su título exacto, sin importar tildes ni mayúsculas", () => {
    const target = p("lista", "ACCION HUMANA · Lo que necesito de ti");
    expect(findHumanActionPanel([p("lista", "Acción humana pendiente"), target])).toBe(target);
  });

  it("si no está el exacto, usa la primera lista que empiece por «Acción humana»", () => {
    const target = p("lista", "Acción humana");
    expect(findHumanActionPanel([p("notas", "Acción humana · lo que necesito de ti"), target])).toBe(target);
  });

  it("ignora otros tipos y devuelve null si no hay", () => {
    expect(findHumanActionPanel([p("notas", "Acción humana · lo que necesito de ti"), p("lista", "Compra")])).toBeNull();
    expect(findHumanActionPanel([])).toBeNull();
  });
});
import type { Agent } from "@/lib/types";

let zen: Agent;
let ana: Agent;

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  zen = getChief()!;
  ana = hireAgent({ name: "Ana", specialty: "Finanzas personales" });
});

const base = (title: string, extra: Partial<NewProposal> = {}): NewProposal => ({
  title,
  description: "Algo **útil**.",
  scope: "finanzas",
  priority: "media",
  impact: "medio",
  effort: "bajo",
  ...extra,
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

describe("parecidos", () => {
  it("palabras clave sin tildes, plurales simples ni palabras vacías", () => {
    expect([...keywords("Revisión de las suscripciones")]).toEqual(["revision", "suscripcion"]);
  });
  it("detecta el mismo tema con otras palabras de relleno", () => {
    expect(isSimilar("Revisión mensual de suscripciones", "Revisar suscripciones: revisión mensual")).toBe(true);
    expect(isSimilar("Conexión Google Calendar (lectura)", "Conectar Google Calendar en lectura")).toBe(true);
    expect(isSimilar("Panel de hábitos y salud", "Plan trimestral del trabajo")).toBe(false);
  });
});

describe("crear y decidir", () => {
  it("crea una pendiente con todos los campos y cuenta en la pestaña", () => {
    const p = createProposal(base("Presupuesto mensual"), zen);
    expect(p).toMatchObject({ status: "pendiente", scope: "finanzas", authorName: "Zen", authorId: zen.id, rejectReason: null });
    expect(countPending()).toBe(1);
    expect(findProposal(p.id.slice(0, 8))?.id).toBe(p.id);
  });

  it("valida ámbito, prioridad, niveles y título", () => {
    expect(() => createProposal(base("x", { scope: "marte" as never }), zen)).toThrow(/Ámbito/);
    expect(() => createProposal(base("y", { priority: "urgente" as never }), zen)).toThrow(/Prioridad/);
    expect(() => createProposal(base("z", { effort: "enorme" as never }), zen)).toThrow(/Esfuerzo/);
    expect(() => createProposal(base("   "), zen)).toThrow(/título/);
  });

  it("aceptar la deja aceptada y avisa a Zen una sola vez", () => {
    const p = createProposal(base("Presupuesto mensual"), zen);
    decideProposal(p.id, "aceptar");
    expect(getProposal(p.id)!.status).toBe("aceptada");
    expect(countPending()).toBe(0);
    const sent = dispatchAccepted();
    expect(sent).toHaveLength(1);
    const task = getTask(sent[0].taskId!)!;
    expect(task).toMatchObject({ agentId: zen.id, kind: "delegation", status: "queued", createdBy: "user" });
    expect(task.prompt).toContain("Presupuesto mensual");
    expect(task.prompt).toContain("propuesta_actualizar");
    expect(dispatchAccepted()).toHaveLength(0);
    expect(listTasks({ agentId: zen.id }).filter((t) => t.data.proposalId === p.id)).toHaveLength(1);
  });

  it("rechazar guarda el motivo; no se puede volver a decidir; recuperar la devuelve", () => {
    const p = createProposal(base("Presupuesto mensual"), zen);
    decideProposal(p.id, "rechazar", { reason: "  Ya lo llevo en Excel  " });
    expect(getProposal(p.id)).toMatchObject({ status: "rechazada", rejectReason: "Ya lo llevo en Excel" });
    expect(() => decideProposal(p.id, "aceptar")).toThrow(/rechazada/);
    decideProposal(p.id, "reabrir");
    expect(getProposal(p.id)).toMatchObject({ status: "pendiente", rejectReason: null });
  });

  it("aplazar la saca del contador hasta su fecha, y se puede aceptar igualmente", () => {
    const at = new Date("2026-10-04T10:00:00Z");
    const p = createProposal(base("Presupuesto mensual"), zen);
    decideProposal(p.id, "aplazar", { days: 7, at });
    const q = getProposal(p.id)!;
    expect(q.postponedUntil).toBe("2026-10-11T10:00:00.000Z");
    expect(countPending(new Date("2026-10-05T00:00:00Z"))).toBe(0);
    expect(countPending(new Date("2026-10-12T00:00:00Z"))).toBe(1);
    expect(viewOf(q, new Date("2026-10-05T00:00:00Z"))).toBe("aplazadas");
    expect(viewOf(q, new Date("2026-10-12T00:00:00Z"))).toBe("decidir");
    expect(() => decideProposal(p.id, "aplazar", { days: 0 })).toThrow(/1 y 365/);
    decideProposal(p.id, "aceptar");
    expect(getProposal(p.id)!.postponedUntil).toBeNull();
  });

  it("cada cambio emite el contador de pendientes", () => {
    const p = createProposal(base("Presupuesto mensual"), zen);
    createProposal(base("Panel de hábitos", { scope: "salud" }), zen);
    decideProposal(p.id, "aceptar");
    const last = eventsAfter(0).filter((e) => e.type.startsWith("proposal.")).at(-1)!;
    expect(last.type).toBe("proposal.updated");
    expect((last.payload as { pending: number }).pending).toBe(1);
  });

  it("no deja proponer algo igual a lo rechazado (y da el motivo) ni duplicar lo abierto", () => {
    const p = createProposal(base("Revisión mensual de suscripciones"), zen);
    decideProposal(p.id, "rechazar", { reason: "Lo hace mi banco" });
    expect(() => createProposal(base("Revisar las suscripciones: revisión mensual"), zen)).toThrow(/Lo hace mi banco/);
    createProposal(base("Panel de hábitos y salud", { scope: "salud" }), zen);
    expect(() => createProposal(base("Panel de hábitos de salud", { scope: "salud" }), zen)).toThrow(/parecida pendiente/);
  });

  it("ordena por prioridad y luego por fecha", () => {
    createProposal(base("Uno baja", { priority: "baja" }), zen);
    createProposal(base("Dos alta", { priority: "alta" }), zen);
    createProposal(base("Tres media", { priority: "media" }), zen);
    expect(listProposals().sort(byPriority).map((p) => p.priority)).toEqual(["alta", "media", "baja"]);
  });
});

describe("avance de Zen", () => {
  it("solo con propuestas aceptadas: en curso y hecha con nota", () => {
    const p = createProposal(base("Presupuesto mensual"), zen);
    expect(() => advanceProposal(p.id, "en_curso", undefined, zen)).toThrow(/aún no la ha aceptado/);
    decideProposal(p.id, "aceptar");
    advanceProposal(p.id, "en_curso", "Empezando", zen);
    expect(getProposal(p.id)).toMatchObject({ status: "en_curso", resultNote: "Empezando", finishedAt: null });
    advanceProposal(p.id, "hecha", "Panel «Presupuesto» creado", zen);
    const done = getProposal(p.id)!;
    expect(done).toMatchObject({ status: "hecha", resultNote: "Panel «Presupuesto» creado" });
    expect(done.finishedAt).not.toBeNull();
    expect(viewOf(done)).toBe("historico");
    expect(() => advanceProposal(p.id, "en_curso", undefined, zen)).toThrow(/No se puede pasar/);
  });
});

describe("herramientas", () => {
  const names = (a: Agent, kind: "chat" | "ambient" = "chat") =>
    toolsOf(a, kind)
      .map((t) => t.name)
      .filter((n) => n.startsWith("propuesta"))
      .sort();

  it("Zen crea y actualiza; el resto solo lee; nadie en tareas de ambiente", () => {
    expect(names(zen)).toEqual(["propuesta_actualizar", "propuesta_crear", "propuestas_listar"]);
    expect(names(ana)).toEqual(["propuestas_listar"]);
    expect(names(zen, "ambient")).toEqual([]);
  });

  it("propuesta_crear, propuestas_listar y propuesta_actualizar de punta a punta", async () => {
    const r = await call(zen, "propuesta_crear", {
      titulo: "Conexión Google Calendar",
      descripcion: "Leer la agenda.",
      ambito: "conexiones",
      prioridad: "alta",
      impacto: "alto",
      esfuerzo: "medio",
    });
    expect(r.isError).toBeFalsy();
    const p = listProposals()[0];
    const before = await call(zen, "propuesta_actualizar", { id: p.id.slice(0, 8), estado: "en_curso" });
    expect(before.isError).toBe(true);
    decideProposal(p.id, "aceptar");
    const upd = await call(zen, "propuesta_actualizar", { id: p.id.slice(0, 8), estado: "hecha", nota: "Conectado" });
    expect(upd.isError).toBeFalsy();
    const list = await call(ana, "propuestas_listar", { estado: "hecha" });
    expect(list.content[0].text).toContain("Conexión Google Calendar");
    expect(list.content[0].text).toContain("Resultado: Conectado");
    expect(listForAgent("pendiente")).toBe("No hay propuestas con ese filtro.");
  });

  it("Zen ve en su contexto lo aceptado por ejecutar y lo rechazado con su motivo", () => {
    expect(chiefProposalsContext()).toBeNull();
    const a = createProposal(base("Presupuesto mensual"), zen);
    const b = createProposal(base("Gimnasio tres días", { scope: "salud" }), zen);
    decideProposal(a.id, "aceptar");
    decideProposal(b.id, "rechazar", { reason: "Prefiero correr" });
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    const ctx = buildContext(zen, task);
    expect(ctx).toContain("Aceptadas por ejecutar");
    expect(ctx).toContain("Presupuesto mensual");
    expect(ctx).toContain("motivo: Prefiero correr");
    expect(buildSystemPrompt(zen, task)).toContain("propuesta_crear");
    const anaTask = createTask({ agentId: ana.id, kind: "chat", prompt: "x" });
    expect(buildContext(ana, anaTask)).not.toContain("Aceptadas por ejecutar");
  });
});

describe("importar un kanban de propuestas", () => {
  const backlog = {
    columns: [
      {
        id: "propuestas",
        title: "Propuestas",
        cards: [
          { id: "c1", title: "Calendario vivo", notes: "Rutinas y plazos.", tags: ["agenda"], priority: "media" },
          { id: "c2", title: "Panel de hábitos y salud", tags: ["salud"], priority: "media" },
          { id: "c3", title: "Plan trimestral del trabajo", tags: ["trabajo"], priority: "media" },
          { id: "c4", title: "Revisión mensual de suscripciones", tags: ["finanzas"], priority: "baja" },
        ],
      },
      { id: "aprobada", title: "Aprobada", cards: [{ id: "c5", title: "Conexión Google Calendar (lectura)", tags: ["conexiones"], priority: "alta" }] },
      { id: "encurso", title: "En curso", cards: [] },
      { id: "hecha", title: "Hecha", cards: [] },
      { id: "descartada", title: "Descartada", cards: [{ id: "c6", title: "Algo descartado", tags: ["raro"] }] },
    ],
  };

  it("columna → estado y etiqueta → ámbito", () => {
    expect(statusFromColumn("Aprobada")).toBe("aceptada");
    expect(statusFromColumn("En curso")).toBe("en_curso");
    expect(statusFromColumn("Hecha")).toBe("hecha");
    expect(statusFromColumn("Descartada")).toBe("rechazada");
    expect(statusFromColumn("Propuestas")).toBe("pendiente");
    expect(scopeFromTags(["Trabajo"])).toBe("trabajo");
    expect(scopeFromTags(["raro"])).toBe("otros");
  });

  it("pasa las tarjetas una sola vez, respeta columnas y no toca el panel", () => {
    const panel = createPanel({ type: "kanban", title: "Ideas", data: backlog, actor: { by: zen.id } });
    const opts = { author: zen, createdAt: panel.createdAt };
    expect(importKanban(panel.id, backlog, opts)).toBe(6);
    const all = listProposals();
    expect(all).toHaveLength(6);
    const by = (t: string) => all.find((p) => p.title === t)!;
    expect(by("Conexión Google Calendar (lectura)")).toMatchObject({ status: "aceptada", scope: "conexiones", priority: "alta", authorName: "Zen" });
    expect(by("Calendario vivo")).toMatchObject({ status: "pendiente", scope: "agenda", description: "Rutinas y plazos.", impact: "medio", effort: "medio" });
    expect(by("Revisión mensual de suscripciones")).toMatchObject({ status: "pendiente", priority: "baja", scope: "finanzas" });
    expect(by("Algo descartado")).toMatchObject({ status: "rechazada", scope: "otros", priority: "media" });
    expect(countPending()).toBe(4);
    // El panel sigue igual y no se importa dos veces.
    expect(getPanel(panel.id)).toMatchObject({ archived: false, version: panel.version, data: panel.data });
    expect(importKanban(panel.id, backlog, opts)).toBe(0);
    expect(listProposals()).toHaveLength(6);
    // La aprobada llega a Zen como encargo.
    expect(dispatchAccepted().map((p) => p.title)).toEqual(["Conexión Google Calendar (lectura)"]);
  });
});
