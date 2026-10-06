import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { pushoverLimit } from "@/lib/connections/pushover";
import { callTool, connect, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const USER = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
const TOKEN = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
useConnTestEnv(() => pushoverLimit.reset());

describe("Pushover", () => {
  it("valida la clave de usuario", () => {
    expect(() => addConnection("pushover", { usuario: "corta" })).toThrow(/30 letras/);
  });

  it("envía solo con permiso completo y limita la prioridad", async () => {
    connect("pushover", { usuario: USER }, TOKEN, { agent: team.ana, level: "completo" });
    expect(toolNames(team.ana, "aviso_pushover")).toEqual(["aviso_pushover"]);
    const calls = mockFetch(() => ({ status: 1 }));
    const r = await callTool(team.ana, "aviso_pushover", { texto: "Paga el IBI", titulo: "Recordatorio", prioridad: 1, enlace: "https://sede.es" });
    expect(textOf(r)).toBe("Aviso enviado (1/30 hoy).");
    expect(calls[0].url).toBe("https://api.pushover.net/1/messages.json");
    expect(jsonBody(calls[0])).toEqual({ token: TOKEN, user: USER, message: "Paga el IBI", title: "Recordatorio", priority: 1, url: "https://sede.es" });
    expect((await callTool(team.ana, "aviso_pushover", { texto: "x", enlace: "javascript:alert(1)" })).isError).toBe(true);
  });

  it("prueba valida sin enviar; errores sin token", async () => {
    const c = connect("pushover", { usuario: USER }, TOKEN);
    const calls = mockFetch(() => ({ status: 1, devices: ["movil"] }));
    expect((await getService("pushover").test(c)).text).toBe("Pushover listo: 1 dispositivo(s) (movil). No se ha enviado nada.");
    expect(calls[0].url).toContain("/users/validate.json");
    mockFetch(() => new Response(JSON.stringify({ status: 0, errors: [`application token is invalid ${TOKEN}`] }), { status: 400 }));
    const t = await getService("pushover").test(c);
    expect(t.ok).toBe(false);
    expect(t.text).not.toContain(TOKEN);
  });
});
