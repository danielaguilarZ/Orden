import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listServices } from "@/lib/connections";
import { serviceInfo } from "@/lib/connections/registry";
import { CATEGORIES, UPCOMING_SERVICES } from "@/lib/connections/catalog";
import { catalogItems, connectionSections, serviceCategory } from "@/lib/connections/view";
import { connect, team, toolsOf, useConnTestEnv } from "./helpers/conn";

useConnTestEnv();

/** Configuración mínima válida de cada servicio nuevo. */
const CONFIGS: Record<string, Record<string, unknown>> = {
  todoist: {},
  trello: { api_key: "0123456789abcdef0123456789abcdef" },
  linear: {},
  discord: {},
  slack: {},
  ntfy: { tema: "orden-prueba" },
  pushover: { usuario: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG" },
  homeassistant: { url: "http://ha.local:8123", acciones: "light.turn_on" },
  ics: { nombre: "Trabajo" },
  cripto: {},
  bolsa: { simbolos: "^IBEX" },
  divisas: {},
  readwise: {},
  raindrop: {},
  obsidian: { carpeta: "" },
  webhook_salida: { nombre: "Hoja" },
  webhook_entrada: { nombre: "Alertas" },
  wikipedia: {},
  festivos: {},
  monitor_webs: { webs: "https://a.es" },
};

describe("catálogo de conexiones", () => {
  it("todas las nuevas están, con categoría válida y al menos 3 pasos", () => {
    const services = listServices().map(serviceInfo);
    const keys = services.map((s) => s.key);
    for (const k of Object.keys(CONFIGS)) expect(keys).toContain(k);
    for (const s of services.filter((x) => CONFIGS[x.key])) {
      expect(CATEGORIES.map((c) => c.key)).toContain(s.category);
      expect(s.steps!.length, s.key).toBeGreaterThanOrEqual(3);
      expect(s.levels.lectura && s.levels.completo, s.key).toBeTruthy();
    }
    // Las que vendrán no se solapan con las disponibles.
    for (const u of UPCOMING_SERVICES) expect(keys).not.toContain(u.key);
    // Los primeros servicios también tienen categoría (por defecto).
    expect(serviceCategory("github")).toBe("dev");
    expect(serviceCategory("telegram")).toBe("avisos");
    expect(serviceCategory("nuevo", "inventada")).toBe("otros");
  });

  it("ordena por categoría en el orden fijo y filtra por categoría", () => {
    const services = listServices().map(serviceInfo);
    const { disponibles, proximamente } = connectionSections(services, [], UPCOMING_SERVICES);
    expect(disponibles).toHaveLength(services.length);
    for (const list of [disponibles, proximamente]) {
      const order = list.map((it) => CATEGORIES.findIndex((c) => c.key === it.category));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
    const avisos = catalogItems(services, UPCOMING_SERVICES, "", "disponibles", "avisos").map((i) => i.key);
    expect(avisos).toEqual(expect.arrayContaining(["telegram", "discord", "slack", "ntfy", "pushover"]));
    expect(avisos).not.toContain("whatsapp");
    expect(disponibles.filter((c) => c.category === "finanzas").length).toBeGreaterThanOrEqual(3);
  });

  it("sin emojis: categorías, nombres y monogramas solo con letras y números", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    const items = catalogItems(listServices().map(serviceInfo), UPCOMING_SERVICES);
    for (const c of CATEGORIES) expect(c.label, c.key).not.toMatch(emoji);
    for (const it of items) {
      expect(`${it.label} ${it.tag}`, it.key).not.toMatch(emoji);
      expect(it.monogram, it.key).toMatch(/^[\p{Lu}\d]{1,2}$/u);
    }
    for (const s of listServices()) expect("icon" in s, s.key).toBe(false);
  });

  it("con todo conectado, ningún nombre de herramienta se repite", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orden-cat-"));
    try {
      for (const [key, config] of Object.entries(CONFIGS)) {
        const info = serviceInfo(listServices().find((s) => s.key === key)!);
        connect(key, key === "obsidian" ? { carpeta: dir } : config, undefined, { agent: team.ana, level: info.readOnly ? "lectura" : "completo" });
      }
      const names = toolsOf(team.ana).map((t) => t.name);
      expect(names.length).toBeGreaterThan(40);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(n).toMatch(/^[a-z0-9_]{1,64}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
