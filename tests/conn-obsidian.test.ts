import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { notesLimit, resolveInside } from "@/lib/connections/obsidian";
import { callTool, connect, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

useConnTestEnv(() => notesLimit.reset());

let vault: string;
let outside: string;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orden-notas-"));
  vault = path.join(base, "Boveda");
  outside = path.join(base, "fuera");
  fs.mkdirSync(path.join(vault, "Diario"), { recursive: true });
  fs.mkdirSync(path.join(vault, ".obsidian"));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(vault, "Ideas.md"), "# Ideas\n- Viaje a Japón en primavera\n");
  fs.writeFileSync(path.join(vault, "Diario", "2026-10-04.md"), "Hoy: dentista.\n");
  fs.writeFileSync(path.join(vault, ".obsidian", "app.json"), "{}");
  fs.writeFileSync(path.join(vault, "foto.png"), "x");
  fs.writeFileSync(path.join(outside, "secreto.md"), "no");
});
afterEach(() => {
  fs.rmSync(path.dirname(vault), { recursive: true, force: true });
});

describe("Notas locales (Obsidian)", () => {
  it("valida la carpeta", () => {
    expect(() => addConnection("obsidian", { carpeta: "relativa/notas" })).toThrow(/ruta completa/);
    expect(() => addConnection("obsidian", { carpeta: path.join(vault, "no-existe") })).toThrow(/No existe/);
    expect(() => addConnection("obsidian", { carpeta: path.parse(vault).root })).toThrow(/raíz/);
    expect(addConnection("obsidian", { carpeta: vault }).name).toBe("Notas · Boveda");
  });

  it("candado de rutas: nada de «..», absolutas, ocultas ni enlaces que salgan", () => {
    expect(() => resolveInside(vault, "../fuera/secreto.md")).toThrow(/\.\./);
    expect(() => resolveInside(vault, path.join(outside, "secreto.md"))).toThrow(/relativas/);
    expect(() => resolveInside(vault, ".obsidian/app.json")).toThrow(/ocultos/);
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(vault, "atajo"), "junction");
      linked = true;
    } catch {
      // Sin permiso para crear enlaces en este sistema: se omite esta parte.
    }
    if (linked) expect(() => resolveInside(vault, "atajo/secreto.md")).toThrow(/sale de la carpeta/);
  });

  it("lectura: listar, buscar y leer solo .md/.txt", async () => {
    connect("obsidian", { carpeta: vault }, undefined, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "notas")).toEqual(["notas_buscar", "notas_leer", "notas_listar"]);
    expect(textOf(await callTool(team.ana, "notas_listar"))).toBe("- 📁 Diario/\n- Ideas.md");
    expect(textOf(await callTool(team.ana, "notas_buscar", { texto: "japón" }))).toBe("- Ideas.md\n  …- Viaje a Japón en primavera");
    expect(textOf(await callTool(team.ana, "notas_buscar", { texto: "2026-10" }))).toBe("- Diario/2026-10-04.md");
    expect(textOf(await callTool(team.ana, "notas_leer", { ruta: "Diario/2026-10-04.md" }))).toBe("Hoy: dentista.\n");
    expect((await callTool(team.ana, "notas_leer", { ruta: "foto.png" })).isError).toBe(true);
    expect((await callTool(team.ana, "notas_leer", { ruta: "../fuera/secreto.md" })).isError).toBe(true);
  });

  it("completo: crea y añade al final, nunca sobrescribe", async () => {
    connect("obsidian", { carpeta: vault }, undefined, { agent: team.ana, level: "completo" });
    expect(textOf(await callTool(team.ana, "notas_escribir", { ruta: "Diario/2026-10-05.md", texto: "Resumen del día", modo: "crear" }))).toBe("Nota creada: Diario/2026-10-05.md");
    const again = await callTool(team.ana, "notas_escribir", { ruta: "Diario/2026-10-05.md", texto: "Otra", modo: "crear" });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("Ya existe");
    await callTool(team.ana, "notas_escribir", { ruta: "Ideas.md", texto: "- Aprender japonés", modo: "anadir" });
    expect(fs.readFileSync(path.join(vault, "Ideas.md"), "utf8")).toBe("# Ideas\n- Viaje a Japón en primavera\n\n- Aprender japonés\n");
    await callTool(team.ana, "notas_escribir", { ruta: "Proyectos/Nuevo.md", texto: "Plan", modo: "anadir" });
    expect(fs.readFileSync(path.join(vault, "Proyectos", "Nuevo.md"), "utf8")).toBe("Plan\n");
    expect((await callTool(team.ana, "notas_escribir", { ruta: "script.js", texto: "x", modo: "crear" })).isError).toBe(true);
    expect((await callTool(team.ana, "notas_escribir", { ruta: ".obsidian/x.md", texto: "x", modo: "crear" })).isError).toBe(true);
    expect(fs.existsSync(path.join(outside, "x.md"))).toBe(false);
  });

  it("prueba cuenta las notas", async () => {
    const c = connect("obsidian", { carpeta: vault });
    expect((await getService("obsidian").test(c)).text).toBe("Carpeta accesible: 2 nota(s) .md/.txt.");
  });
});
