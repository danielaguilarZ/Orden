import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService, serviceInfo } from "@/lib/connections/registry";
import { ntfyLimit } from "@/lib/connections/ntfy";
import { connectionStatus } from "@/lib/connections/view";
import { publicConnection } from "@/lib/repo/connections";
import { callTool, connect, headersOf, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const TOKEN = "tk_abcdefghijklmnopqrstuvwxyz012";
useConnTestEnv(() => ntfyLimit.reset());

describe("ntfy", () => {
  it("valida servidor y tema; el token es opcional", () => {
    expect(() => addConnection("ntfy", { tema: "mal tema" })).toThrow(/tema/);
    expect(() => addConnection("ntfy", { tema: "ok", servidor: "ftp://x" })).toThrow(/http/);
    const c = addConnection("ntfy", { tema: "orden-dani", servidor: "https://ntfy.miservidor.es/ruta" });
    expect(c.config).toEqual({ servidor: "https://ntfy.miservidor.es", tema: "orden-dani" });
    const status = connectionStatus({ ...publicConnection(c), oauth: null }, serviceInfo(getService("ntfy")));
    expect(status).toMatchObject({ tone: "ok", needsSetup: false });
  });

  it("lectura lee el tema; completo envía con título, prioridad y etiquetas", async () => {
    connect("ntfy", { tema: "orden-dani" }, undefined, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "")).toContain("ntfy_mensajes");
    expect(toolNames(team.ana, "aviso_ntfy")).toEqual([]);
    const lines = [
      JSON.stringify({ event: "open", time: 1 }),
      JSON.stringify({ event: "message", time: 1791187200, title: "Idea", message: "Comprar regalo" }),
    ].join("\n");
    const calls = mockFetch(() => lines);
    expect(textOf(await callTool(team.ana, "ntfy_mensajes", { horas: 12 }))).toBe("- 2026-10-05 08:00 UTC · Idea: Comprar regalo");
    expect(calls[0].url).toBe("https://ntfy.sh/orden-dani/json?poll=1&since=12h");
    expect(headersOf(calls[0]).get("authorization")).toBeNull();
  });

  it("completo con token: lo manda en la cabecera", async () => {
    connect("ntfy", { tema: "privado" }, TOKEN, { agent: team.ana, level: "completo" });
    const calls = mockFetch(() => ({ id: "x" }));
    const r = await callTool(team.ana, "aviso_ntfy", { texto: "Reunión en 10 min", titulo: "Agenda", prioridad: 4, etiquetas: ["calendar"] });
    expect(textOf(r)).toBe("Aviso enviado (1/30 hoy).");
    expect(calls[0].url).toBe("https://ntfy.sh/");
    expect(jsonBody(calls[0])).toEqual({ topic: "privado", message: "Reunión en 10 min", title: "Agenda", priority: 4, tags: ["calendar"] });
    expect(headersOf(calls[0]).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("prueba: salud del servidor y acceso al tema", async () => {
    const c = connect("ntfy", { tema: "privado" }, TOKEN);
    mockFetch((url) => (url.endsWith("/v1/health") ? { healthy: true } : ""));
    expect((await getService("ntfy").test(c)).text).toContain("tema «privado» accesible");
    mockFetch((url) => (url.endsWith("/v1/health") ? { healthy: true } : new Response(`forbidden ${TOKEN}`, { status: 403 })));
    const t = await getService("ntfy").test(c);
    expect(t.ok).toBe(false);
    expect(t.text).not.toContain(TOKEN);
  });
});
