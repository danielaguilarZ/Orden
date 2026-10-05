import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import {
  applyPanelOps,
  archivePanel,
  createPanel,
  getPanel,
  listPanels,
  listVersions,
  restoreVersion,
  reorderPanels,
} from "@/lib/repo/panels";
import { applyOp, habitStreak, normalizeData, opsGuide, PANEL_TYPES, tableTotals, type CalendarData, type KanbanData, type TableData } from "@/lib/panels/types";
import { buildTools } from "@/lib/agents/tools";
import { buildContext } from "@/lib/agents/prompt";
import { eventsAfter } from "@/lib/events";
import "@/lib/agents/modules";

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

const USER = { by: "user" };

describe("motor de paneles (operaciones puras)", () => {
  it("todos los tipos tienen un estado vacío válido", () => {
    for (const t of Object.values(PANEL_TYPES)) expect(() => normalizeData(t.type, t.empty())).not.toThrow();
  });

  it("calendario: añadir, cambiar y quitar eventos", () => {
    let d = PANEL_TYPES.calendario.empty() as CalendarData;
    d = applyOp("calendario", d, { op: "add_event", id: "e1", title: "Dentista", start: "2026-10-05T10:00" }) as CalendarData;
    d = applyOp("calendario", d, { op: "add_event", title: "Cumple de Ana", start: "2026-10-07" }) as CalendarData;
    expect(d.events[0].allDay).toBe(false);
    expect(d.events[1].allDay).toBe(true);
    d = applyOp("calendario", d, { op: "update_event", id: "e1", start: "2026-10-06T11:00" }) as CalendarData;
    expect(d.events[0].start).toBe("2026-10-06T11:00");
    d = applyOp("calendario", d, { op: "remove_event", id: "e1" }) as CalendarData;
    expect(d.events).toHaveLength(1);
    expect(() => applyOp("calendario", d, { op: "add_event", title: "x", start: "mañana" })).toThrow(/AAAA-MM-DD/);
  });

  it("kanban: columnas por título y mover tarjetas", () => {
    let d = PANEL_TYPES.kanban.empty() as KanbanData;
    d = applyOp("kanban", d, { op: "add_card", column: "pendiente", id: "c1", title: "Renovar DNI" }) as KanbanData;
    d = applyOp("kanban", d, { op: "move_card", id: "c1", column: "Hecho" }) as KanbanData;
    expect(d.columns.find((c) => c.title === "Hecho")!.cards[0].title).toBe("Renovar DNI");
    expect(d.columns[0].cards).toHaveLength(0);
    expect(() => applyOp("kanban", d, { op: "move_card", id: "zz", column: "Hecho" })).toThrow(/tarjeta/);
  });

  it("tabla: totales de columnas marcadas", () => {
    let d = PANEL_TYPES.tabla.empty() as TableData;
    d = applyOp("tabla", d, {
      op: "set_columns",
      columns: [
        { key: "concepto", label: "Concepto" },
        { key: "importe", label: "Importe", type: "moneda", total: true },
      ],
    }) as TableData;
    d = applyOp("tabla", d, { op: "add_row", cells: { concepto: "Alquiler", importe: 800 } }) as TableData;
    d = applyOp("tabla", d, { op: "add_row", cells: { concepto: "Luz", importe: 55.5 } }) as TableData;
    expect(tableTotals(d)).toEqual({ importe: 855.5 });
  });

  it("operación o argumentos desconocidos dan errores claros", () => {
    expect(() => applyOp("lista", { items: [] }, { op: "volar" })).toThrow(/no existe/);
    expect(() => applyOp("lista", { items: [] }, { op: "add_item" })).toThrow(/text/);
    expect(() => applyOp("inventado", {}, { op: "x" })).toThrow(/desconocido/);
  });

  it("racha de hábitos", () => {
    const h = { id: "h", name: "Agua", log: { "2026-10-01": true, "2026-10-02": true, "2026-09-30": false } };
    expect(habitStreak(h, "2026-10-02")).toBe(2);
    expect(habitStreak(h, "2026-10-03")).toBe(2); // hoy aún sin marcar no rompe la racha
  });

  it("la guía para el modelo incluye la firma de las operaciones", () => {
    expect(opsGuide()).toContain("add_event(title, start, end?");
  });
});

describe("paneles en la base de datos", () => {
  it("cada operación emite un evento (se ve construirse) y guarda una versión por encargo", async () => {
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    const p = createPanel({ type: "lista", title: "Compra", actor: { by: zen.id, taskId: task.id } });
    const before = eventsAfter(0).length;
    await applyPanelOps(p.id, [{ op: "add_item", text: "Pan" }, { op: "add_item", text: "Leche" }], { by: zen.id, taskId: task.id });
    await applyPanelOps(p.id, [{ op: "add_item", text: "Huevos" }], { by: zen.id, taskId: task.id });
    expect(eventsAfter(0).length - before).toBe(3);
    // Un solo encargo → una sola instantánea (el estado vacío original).
    expect(listVersions(p.id)).toHaveLength(1);
    // Una edición manual crea otra.
    await applyPanelOps(p.id, [{ op: "toggle_item", id: (getPanel(p.id)!.data as { items: { id: string }[] }).items[0].id }], USER);
    expect(listVersions(p.id)).toHaveLength(2);
  });

  it("se puede deshacer restaurando una versión, y restaurar también se puede deshacer", async () => {
    const p = createPanel({ type: "notas", title: "Ideas", actor: USER, data: { markdown: "uno" } });
    await applyPanelOps(p.id, [{ op: "set_text", markdown: "dos" }], USER);
    const [v] = listVersions(p.id);
    restoreVersion(p.id, v.id, USER);
    expect((getPanel(p.id)!.data as { markdown: string }).markdown).toBe("uno");
    expect(listVersions(p.id).length).toBe(2);
  });

  it("una operación fallida para el lote y deja lo anterior aplicado", async () => {
    const p = createPanel({ type: "lista", title: "L", actor: USER });
    const r = await applyPanelOps(p.id, [{ op: "add_item", text: "a" }, { op: "toggle_item" }, { op: "add_item", text: "c" }], USER);
    expect(r.applied).toBe(1);
    expect(r.error).toMatch(/Operación 2/);
  });

  it("archivar lo manda a la papelera y se puede recuperar", () => {
    const p = createPanel({ type: "lista", title: "L", actor: USER });
    archivePanel(p.id, USER);
    expect(listPanels()).toHaveLength(0);
    expect(listPanels({ archived: true })).toHaveLength(1);
    archivePanel(p.id, USER, false);
    expect(listPanels()).toHaveLength(1);
  });

  it("los paneles nuevos salen primero y se pueden reordenar", () => {
    const a = createPanel({ type: "lista", title: "A", actor: USER });
    const b = createPanel({ type: "lista", title: "B", actor: USER });
    expect(listPanels().map((p) => p.title)).toEqual(["B", "A"]);
    reorderPanels([a.id, b.id]);
    expect(listPanels().map((p) => p.title)).toEqual(["A", "B"]);
  });
});

describe("herramientas de paneles para agentes", () => {
  it("panel_crear crea y rellena; el prompt lista los paneles", async () => {
    process.env.ORDEN_PANEL_STEP_MS = "0";
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    const notes: string[] = [];
    const tools = buildTools({ agent: zen, task, signal: new AbortController().signal, note: (t) => notes.push(t) });
    const crear = tools.find((t) => t.name === "panel_crear")!;
    const res = (await crear.handler(
      {
        tipo: "calendario",
        titulo: "Semana",
        operaciones: [
          { op: "add_event", title: "Gimnasio", start: "2026-10-05T19:00" },
          { op: "add_event", title: "Cena", start: "2026-10-06T21:00" },
        ],
      },
      {},
    )) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    const [panel] = listPanels();
    expect((panel.data as CalendarData).events).toHaveLength(2);
    expect(panel.agentId).toBe(zen.id);
    expect(notes[0]).toContain("Semana");
    expect(buildContext(zen, task)).toContain(`${panel.id} · calendario · Semana`);
  });
});
