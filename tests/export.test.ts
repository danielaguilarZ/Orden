import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { exportPanel, fileSlug, formatsFor, toCsv, toIcs, toMarkdown, toXlsx } from "@/lib/panels/export";

const table = {
  type: "tabla",
  title: "Gastos: octubre",
  data: {
    currency: "EUR",
    columns: [
      { key: "c", label: "Concepto", type: "texto" },
      { key: "i", label: "Importe", type: "moneda", total: true },
    ],
    rows: [
      { id: "1", cells: { c: "Alquiler; piso", i: 750 } },
      { id: "2", cells: { c: 'Luz "verde"', i: 55.5 } },
    ],
  },
};

const calendar = {
  type: "calendario",
  title: "Semana, con prisas",
  data: {
    view: "semana",
    events: [
      { id: "a", title: "Dentista", start: "2026-10-07T10:00", end: "2026-10-07T11:00", location: "C/ Mayor, 3" },
      { id: "b", title: "Cumple de Laura", start: "2026-10-09", allDay: true },
      { id: "c", title: "Llamar al banco por la hipoteca y preguntar por las condiciones del préstamo personal", start: "2026-10-08T09:00" },
    ],
  },
};

describe("exportación", () => {
  it("formatos por tipo", () => {
    expect(formatsFor("calendario")).toEqual(["md", "csv", "xlsx", "ics"]);
    expect(formatsFor("notas")).toEqual(["md"]);
    expect(() => exportPanel({ type: "notas", title: "x", data: { markdown: "" } }, "csv")).toThrow();
  });

  it("CSV con BOM, punto y coma, comillas escapadas y fila de total", () => {
    const csv = toCsv(table);
    expect(csv.startsWith("﻿Concepto;Importe")).toBe(true);
    expect(csv).toContain('"Alquiler; piso";750');
    expect(csv).toContain('"Luz ""verde""";55.5');
    expect(csv.trim().split("\r\n").at(-1)).toBe("Total;805.5");
  });

  it("Markdown: tabla, lista con casillas y calendario por días", () => {
    expect(toMarkdown(table)).toContain("| Concepto | Importe |");
    const list = toMarkdown({ type: "lista", title: "Compra", data: { checkable: true, items: [{ id: "1", text: "Pan", done: true }] } });
    expect(list).toContain("- [x] Pan");
    const cal = toMarkdown(calendar);
    expect(cal).toContain("## 2026-10-07");
    expect(cal).toContain("10:00–11:00 · Dentista (C/ Mayor, 3)");
  });

  it("XLSX válido: zip con hoja, cabecera y números como números", () => {
    const files = unzipSync(toXlsx(table));
    expect(Object.keys(files)).toContain("xl/worksheets/sheet1.xml");
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain('<c r="B2"><v>750</v></c>');
    expect(sheet).toContain("Luz &quot;verde&quot;");
    expect(strFromU8(files["xl/workbook.xml"])).toContain('name="Gastos  octubre"');
  });

  it("ICS: eventos con hora flotante, días completos, escapes y líneas plegadas", () => {
    const ics = toIcs(calendar, { id: "p1", now: new Date("2026-10-02T10:00:00Z") });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20261007T100000");
    expect(ics).toContain("DTEND:20261007T110000");
    expect(ics).toContain("LOCATION:C/ Mayor\\, 3");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261009");
    expect(ics).toContain("DTEND;VALUE=DATE:20261010");
    expect(ics).toContain("DURATION:PT1H");
    expect(ics).toContain("X-WR-CALNAME:Semana\\, con prisas");
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics).toMatch(/\r\n [^\r]/); // hay al menos una línea plegada
  });

  it("nombres de archivo seguros", () => {
    expect(fileSlug("Presupuesto Mensual - 2.000 € netos")).toBe("presupuesto-mensual-2-000-netos");
    expect(fileSlug("¿?")).toBe("panel");
  });
});
