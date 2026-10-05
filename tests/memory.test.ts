import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import {
  archiveMemory,
  createMemory,
  ftsQuery,
  getMemory,
  listMemory,
  listMemoryVersions,
  restoreMemoryVersion,
  searchMemory,
  updateMemory,
  upsertMemory,
} from "@/lib/repo/memory";
import { buildContext } from "@/lib/agents/prompt";
import { buildTools } from "@/lib/agents/tools";
import "@/lib/agents/modules";

const USER = { by: "user" };

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

describe("memoria compartida", () => {
  it("consulta tolerante: sin tildes, por prefijo y sin palabras vacías", () => {
    expect(ftsQuery("¿Cuándo es el cumpleaños de Laura?")).toBe('"cumpl"* OR "laura"*');
    expect(ftsQuery("de la el")).toBeNull();
  });

  it("encuentra lo relevante aunque cambien tildes y formas de la palabra", () => {
    createMemory({ category: "personas", title: "Cumpleaños de Laura", content: "12 de marzo. Le gustan las plantas." }, USER);
    createMemory({ category: "preferencias", title: "Comida", content: "Vegetariano, sin picante." }, USER);
    createMemory({ category: "objetivos", title: "Finanzas", content: "Ahorrar 300 € al mes para la entrada de un piso." }, USER);
    expect(searchMemory("regalo para el cumple de laura")[0].title).toBe("Cumpleaños de Laura");
    expect(searchMemory("financiero ahorro")[0].title).toBe("Finanzas");
    expect(searchMemory("dentista")).toHaveLength(0);
  });

  it("guardar con el mismo título actualiza en vez de duplicar", () => {
    upsertMemory({ category: "quien_soy", title: "Ciudad", content: "Madrid" }, USER);
    const { created } = upsertMemory({ category: "quien_soy", title: "ciudad", content: "Valencia" }, USER);
    expect(created).toBe(false);
    const all = listMemory({ category: "quien_soy" });
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("Valencia");
  });

  it("historial: se puede restaurar y olvidar es recuperable", () => {
    const e = createMemory({ category: "rutinas", title: "Gimnasio", content: "Lunes y jueves" }, USER);
    updateMemory(e.id, { content: "Martes y viernes" }, { by: "agente", taskId: "t1" });
    const [v] = listMemoryVersions(e.id);
    restoreMemoryVersion(e.id, v.id, USER);
    expect(getMemory(e.id)!.content).toBe("Lunes y jueves");
    archiveMemory(e.id, USER);
    expect(searchMemory("gimnasio")).toHaveLength(0);
    expect(listMemory({ archived: true })).toHaveLength(1);
  });

  it("el prompt incluye lo básico y SOLO los recuerdos relevantes para el encargo", () => {
    createMemory({ category: "quien_soy", title: "Nombre", content: "Daniel" }, USER);
    createMemory({ category: "personas", title: "Laura", content: "Pareja. Cumple el 12 de marzo." }, USER);
    createMemory({ category: "proyectos", title: "Reforma de la cocina", content: "Presupuesto 8.000 €" }, USER);
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "Organiza la cena de cumpleaños de Laura" });
    const prompt = buildContext(zen, task);
    expect(prompt).toContain("Nombre: Daniel");
    expect(prompt).toContain("Laura: Pareja");
    expect(prompt).not.toContain("Reforma de la cocina");
  });

  it("las herramientas guardan con nota en el chat y buscan", async () => {
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    const notes: string[] = [];
    const tools = buildTools({ agent: zen, task, signal: new AbortController().signal, note: (t) => notes.push(t) });
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await tools.find((t) => t.name === name)!.handler(args, {})) as { content: { text: string }[] }).content[0].text;
    await call("memoria_guardar", { categoria: "preferencias", titulo: "Horario", contenido: "Prefiere reuniones por la mañana" });
    expect(notes[0]).toContain("Horario");
    expect(await call("memoria_buscar", { consulta: "reuniones" })).toContain("Horario");
    expect(listMemory()[0].source).toBe(zen.id);
  });
});
