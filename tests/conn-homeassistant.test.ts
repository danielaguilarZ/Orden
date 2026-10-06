import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { actionAllowed, haLimit } from "@/lib/connections/homeassistant";
import { callTool, connect, headersOf, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz.0123456789";
useConnTestEnv(() => haLimit.reset());

const states = [
  { entity_id: "sensor.temp_salon", state: "21.5", attributes: { friendly_name: "Temperatura salón", unit_of_measurement: "°C" } },
  { entity_id: "light.salon", state: "off", attributes: { friendly_name: "Luz salón", brightness: null } },
  { entity_id: "light.cocina", state: "on", attributes: { friendly_name: "Luz cocina" } },
];

describe("Home Assistant", () => {
  it("valida dirección, acciones y entidades", () => {
    expect(() => addConnection("homeassistant", { url: "nada" })).toThrow(/dirección/);
    expect(() => addConnection("homeassistant", { url: "http://ha.local:8123", acciones: "rm -rf" })).toThrow(/Acción no válida/);
    const c = addConnection("homeassistant", { url: "http://ha.local:8123/", acciones: "light.turn_on, light.turn_off", entidades: "light.*" });
    expect(c.config).toEqual({ url: "http://ha.local:8123", acciones: ["light.turn_on", "light.turn_off"], entidades: ["light.*"] });
    expect(actionAllowed(c.config, "light.turn_on", "light.salon")).toBeNull();
    expect(actionAllowed(c.config, "lock.unlock", "lock.puerta")).toContain("no está en la lista");
    expect(actionAllowed(c.config, "light.turn_on", "switch.horno")).toContain("entidad");
  });

  it("lectura: estados filtrados y una entidad con atributos", async () => {
    connect("homeassistant", { url: "http://ha.local:8123" }, TOKEN, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "casa")).toEqual(["casa_estado", "casa_estados"]);
    const calls = mockFetch((url) => (url.endsWith("/api/states") ? states : states[0]));
    const r = textOf(await callTool(team.ana, "casa_estados", { dominio: "light" }));
    expect(r).toBe("2 entidad(es):\n- Luz cocina (light.cocina): on\n- Luz salón (light.salon): off");
    expect(headersOf(calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const one = textOf(await callTool(team.ana, "casa_estado", { entidad: "sensor.temp_salon" }));
    expect(one).toContain("- Temperatura salón (sensor.temp_salon): 21.5 °C");
    expect(one).toContain("unit_of_measurement: °C");
    expect((await callTool(team.ana, "casa_estado", { entidad: "../config" })).isError).toBe(true);
  });

  it("completo: solo acciones y entidades permitidas", async () => {
    connect("homeassistant", { url: "http://ha.local:8123", acciones: "light.turn_on", entidades: "light.*" }, TOKEN, { agent: team.ana, level: "completo" });
    const calls = mockFetch(() => [states[1]]);
    const r = await callTool(team.ana, "casa_accion", { accion: "light.turn_on", entidad: "light.salon", datos: { brightness_pct: 40 } });
    expect(textOf(r)).toBe("Hecho: light.turn_on en light.salon (1 entidad(es) cambiaron).");
    expect(calls[0].url).toBe("http://ha.local:8123/api/services/light/turn_on");
    expect(jsonBody(calls[0])).toEqual({ brightness_pct: 40, entity_id: "light.salon" });
    const denied = await callTool(team.ana, "casa_accion", { accion: "lock.unlock", entidad: "lock.puerta" });
    expect(denied.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("prueba sin mostrar el token", async () => {
    const c = connect("homeassistant", { url: "http://ha.local:8123" }, TOKEN);
    mockFetch((url) => (url.endsWith("/api/config") ? { location_name: "Casa", version: "2026.10.0" } : states));
    expect((await getService("homeassistant").test(c)).text).toBe("Home Assistant «Casa» (versión 2026.10.0): 3 entidades.");
    mockFetch(() => new Response(`401 ${TOKEN}`, { status: 401 }));
    const t = await getService("homeassistant").test(c);
    expect(t.ok).toBe(false);
    expect(t.text).not.toContain(TOKEN);
  });
});
