import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { createPanel } from "@/lib/repo/panels";
import { PANEL_TYPES } from "@/lib/panels/types";
import { panelTemplates, TYPE_INFO, typeName } from "@/lib/panels/templates";

describe("plantillas de paneles", () => {
  const templates = panelTemplates("2026-10-05");

  it("todos los tipos tienen nombre, explicación e icono, y ninguno sobra", () => {
    expect(Object.keys(TYPE_INFO).sort()).toEqual(Object.keys(PANEL_TYPES).sort());
    for (const info of Object.values(TYPE_INFO)) {
      expect(info.name.length).toBeGreaterThan(2);
      expect(info.hint.length).toBeGreaterThan(5);
      expect(info.icon).toBeTruthy();
    }
    expect(typeName("kanban")).toBe("Tablero");
    expect(typeName("desconocido")).toBe("desconocido");
  });

  it("ids únicos y datos válidos para su tipo (el esquema no los cambia)", () => {
    expect(new Set(templates.map((t) => t.id)).size).toBe(templates.length);
    for (const t of templates) {
      const type = PANEL_TYPES[t.type];
      expect(type, t.id).toBeDefined();
      expect(type.schema.parse(t.data), t.id).toEqual(t.data);
    }
  });

  it("la agenda se centra en hoy y los gastos suman el importe", () => {
    expect(templates.find((t) => t.id === "agenda")!.data).toMatchObject({ view: "semana", focus: "2026-10-05" });
    const gastos = templates.find((t) => t.id === "gastos")!.data as { columns: { key: string; total?: boolean }[] };
    expect(gastos.columns.find((c) => c.key === "importe")?.total).toBe(true);
  });

  describe("crear desde una plantilla", () => {
    beforeEach(() => {
      setDbForTests(openDb(":memory:"));
      ensureSeed();
    });

    it("crea el panel con su título y contenido", () => {
      for (const t of templates) {
        const p = createPanel({ type: t.type, title: t.title, data: t.data, actor: { by: "user" } });
        expect(p).toMatchObject({ type: t.type, title: t.title });
        expect(p.data).toEqual(t.data);
      }
    });
  });
});
