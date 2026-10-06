import { beforeEach, describe, expect, it } from "vitest";
import { getDb, openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import { buildTools } from "@/lib/agents/tools";
import { buildContext, buildSystemPrompt } from "@/lib/agents/prompt";
import { snapshot } from "@/lib/server";
import "@/lib/agents/modules";

/**
 * Los paneles se quitaron de Orden: ni herramientas ni contexto para los
 * agentes, ni datos en la interfaz. Sus tablas siguen en la base de datos
 * (no se borra nada).
 */

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

describe("paneles retirados", () => {
  it("ningún agente tiene herramientas de paneles", () => {
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    const names = buildTools({ agent: zen, task, signal: new AbortController().signal, note: () => {} }).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("panel"))).toEqual([]);
    expect(names).toContain("archivo_escribir");
  });

  it("ni el prompt ni el contexto hablan de paneles", () => {
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    const text = `${buildSystemPrompt(zen, task)}\n${buildContext(zen, task)}`;
    expect(text).not.toMatch(/panel_crear|panel_editar|Paneles (vivos|existentes)/);
    expect(text).toContain("Archivos");
  });

  it("la instantánea de la interfaz ya no lleva paneles", () => {
    expect(Object.keys(snapshot())).not.toContain("panels");
  });

  it("las tablas de paneles se conservan (migración no destructiva)", () => {
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('panels', 'panel_versions') ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["panel_versions", "panels"]);
  });
});
