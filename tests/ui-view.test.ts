import { describe, expect, it } from "vitest";
import { dayKey, dayLabel, daysAgo, fold, groupByDay, hasMore, matches, plural, relativeDate, summarize, truncate, whenLabel } from "@/lib/ui/text";
import { categoryIcon, countByCategory, filterMemory, groupMemory, memoryCategories } from "@/lib/memory/view";
import { answerParts, answerTone, decisionKind } from "@/lib/decisions/labels";

// Fechas en hora local para no depender de la zona del equipo que pasa los tests.
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 9, 5, 22, 0); // lunes 5 oct 2026, 22:00

describe("texto: búsqueda y resúmenes", () => {
  it("fold quita tildes y mayúsculas", () => {
    expect(fold("Canción ÁRBOL Pingüino")).toBe("cancion arbol pinguino");
  });

  it("matches exige todas las palabras, sin tildes ni orden", () => {
    expect(matches("Cumpleaños de Laura en marzo", "laura cumpleanos")).toBe(true);
    expect(matches("Cumpleaños de Laura", "laura junio")).toBe(false);
    expect(matches("lo que sea", "   ")).toBe(true);
  });

  it("summarize toma la primera línea con texto y quita markdown", () => {
    expect(summarize("\n# Título **fuerte**\nSegunda línea")).toBe("Título fuerte");
    expect(summarize("- [x] Hecho con [enlace](https://x.y) y `código`")).toBe("Hecho con enlace y código");
    expect(summarize("")).toBe("");
  });

  it("truncate no parte palabras y añade «…»", () => {
    const s = truncate("uno dos tres cuatro cinco seis siete", 20);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s).toBe("uno dos tres cuatro…");
    expect(truncate("corto", 20)).toBe("corto");
  });

  it("hasMore detecta varias líneas o una línea larga", () => {
    expect(hasMore("una línea")).toBe(false);
    expect(hasMore("una\notra")).toBe(true);
    expect(hasMore("x".repeat(50), 40)).toBe(true);
  });

  it("plural", () => {
    expect(plural(1, "recuerdo", "recuerdos")).toBe("1 recuerdo");
    expect(plural(0, "recuerdo", "recuerdos")).toBe("0 recuerdos");
  });
});

describe("texto: fechas", () => {
  it("daysAgo cuenta días naturales en hora local", () => {
    expect(daysAgo(local(2026, 10, 5, 0, 1), NOW)).toBe(0);
    expect(daysAgo(local(2026, 10, 4, 23, 59), NOW)).toBe(1);
    expect(daysAgo(local(2026, 10, 6, 8), NOW)).toBe(-1);
  });

  it("relativeDate: hoy, ayer, hace N días y fecha corta", () => {
    expect(relativeDate(local(2026, 10, 5), NOW)).toBe("hoy");
    expect(relativeDate(local(2026, 10, 4), NOW)).toBe("ayer");
    expect(relativeDate(local(2026, 10, 1), NOW)).toBe("hace 4 días");
    expect(relativeDate(local(2026, 9, 1), NOW)).toMatch(/1.*sept?/);
    expect(relativeDate(local(2025, 9, 1), NOW)).toMatch(/2025/);
  });

  it("whenLabel para lo próximo", () => {
    expect(whenLabel(local(2026, 10, 5, 23, 30), NOW)).toBe("hoy 23:30");
    expect(whenLabel(local(2026, 10, 6, 8, 0), NOW)).toBe("mañana 08:00");
  });

  it("dayLabel: Hoy, Ayer o día de la semana en mayúscula", () => {
    expect(dayLabel(local(2026, 10, 5), NOW)).toBe("Hoy");
    expect(dayLabel(local(2026, 10, 4), NOW)).toBe("Ayer");
    expect(dayLabel(local(2026, 10, 3), NOW)).toMatch(/^Sábado/);
  });

  it("groupByDay agrupa seguidos por día local y mantiene el orden", () => {
    const items = [local(2026, 10, 5, 20), local(2026, 10, 5, 9), local(2026, 10, 4, 18), local(2026, 10, 2, 7)].map((iso, i) => ({ i, iso }));
    const g = groupByDay(items, (x) => x.iso);
    expect(g.map((d) => d.day)).toEqual(["2026-10-05", "2026-10-04", "2026-10-02"]);
    expect(g[0].items.map((x) => x.i)).toEqual([0, 1]);
    expect(dayKey(local(2026, 1, 9))).toBe("2026-01-09");
  });
});

describe("memoria: vista por categorías", () => {
  const e = (category: string, title: string, content = "", tags: string[] = [], updatedAt = "2026-10-01T10:00:00Z") => ({ category, title, content, tags, updatedAt });
  const entries = [
    e("personas", "Cumpleaños de Laura", "12 de marzo", ["familia"], "2026-10-02T10:00:00Z"),
    e("personas", "Teléfono de Pepe", "600 000 000", [], "2026-10-04T10:00:00Z"),
    e("objetivos", "Ahorrar", "10 % al mes", ["dinero"]),
    e("mascotas", "Gato", "Se llama Misi"),
  ];

  it("categorías conocidas primero y las nuevas al final, con icono", () => {
    const cats = memoryCategories(entries);
    expect(cats[0].key).toBe("quien_soy");
    expect(cats.at(-1)).toMatchObject({ key: "mascotas", label: "Mascotas", icon: "🗂️" });
    expect(categoryIcon("objetivos")).toBe("🎯");
  });

  it("filtra por texto (título, contenido, etiquetas y categoría) y por categoría", () => {
    expect(filterMemory(entries, "cumpleanos").map((x) => x.title)).toEqual(["Cumpleaños de Laura"]);
    expect(filterMemory(entries, "familia").length).toBe(1);
    expect(filterMemory(entries, "personas importantes").length).toBe(2);
    expect(filterMemory(entries, "", "objetivos").map((x) => x.title)).toEqual(["Ahorrar"]);
    expect(filterMemory(entries, "misi", "personas")).toEqual([]);
  });

  it("agrupa solo lo que tiene algo, en orden de categorías y lo más reciente primero", () => {
    const g = groupMemory(entries);
    expect(g.map((x) => x.cat.key)).toEqual(["objetivos", "personas", "mascotas"]);
    expect(g[1].entries.map((x) => x.title)).toEqual(["Teléfono de Pepe", "Cumpleaños de Laura"]);
    expect(countByCategory(entries)).toEqual({ personas: 2, objetivos: 1, mascotas: 1 });
  });
});

describe("decisiones: chips", () => {
  it("decisionKind según el tipo de pregunta", () => {
    expect(decisionKind({ approval: true, options: [] }).label).toBe("Sí / No");
    expect(decisionKind({ approval: false, options: ["a", "b"] }).label).toBe("Elegir (2)");
    expect(decisionKind({ approval: false, options: [] }).label).toBe("Respuesta");
  });

  it("answerParts separa estado y respuesta; answerTone da el color", () => {
    expect(answerParts({ answerKind: "rechazar", answer: " caro ", status: "resuelta" })).toEqual({ state: "Rechazada", detail: "caro" });
    expect(answerParts({ answerKind: "opcion", answer: "B", status: "resuelta" })).toEqual({ state: "Elegida", detail: "B" });
    expect(answerParts({ answerKind: "retirada", answer: "x", status: "resuelta" }).detail).toBe("");
    expect(answerTone("rechazar")).toBe("bad");
    expect(answerTone("aceptar")).toBe("ok");
    expect(answerTone(null)).toBe("off");
  });
});
