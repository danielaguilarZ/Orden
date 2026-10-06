import { describe, expect, it } from "vitest";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { checkWebhookUrl, isPrivateHost, webhookOutLimit } from "@/lib/connections/webhook-out";
import { receivedItems, receiveLimit, receiveWebhook, sameSecret, summarize, taskLimit, tokenFrom, WebhookError } from "@/lib/connections/webhook-in";
import { getTask } from "@/lib/repo/tasks";
import { updateConnection } from "@/lib/repo/connections";
import { callTool, connect, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const OUT = "https://hooks.zapier.com/hooks/catch/123/abcSECRETxyz/";
const KEY = "clave-secreta-de-prueba-0123456789";
useConnTestEnv(() => {
  webhookOutLimit.reset();
  receiveLimit.reset();
  taskLimit.reset();
});

describe("Webhook saliente", () => {
  it("https siempre; http solo local o red privada", () => {
    expect(checkWebhookUrl(OUT)).toBe(OUT);
    expect(checkWebhookUrl("http://localhost:5678/webhook/x")).toBe("http://localhost:5678/webhook/x");
    expect(checkWebhookUrl("http://192.168.1.20:8123/api/webhook/x")).toContain("192.168.1.20");
    expect(() => checkWebhookUrl("http://ejemplo.com/hook")).toThrow(/https/);
    expect(isPrivateHost("172.20.0.1")).toBe(true);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(() => addConnection("webhook_salida", {})).toThrow(/nombre/);
  });

  it("solo con permiso completo; envía JSON con agente y datos; la dirección no se filtra", async () => {
    connect("webhook_salida", { nombre: "Gastos", para_que: "Apunta {importe, concepto} en mi hoja" }, OUT, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "webhook_enviar")).toEqual([]);
    connect("webhook_salida", { nombre: "Gastos 2" }, OUT, { agent: team.ana, level: "completo" });
    const calls = mockFetch(() => `ok ${OUT}`);
    const r = await callTool(team.ana, "webhook_enviar", { texto: "Café", datos: { importe: 2.5 } });
    expect(textOf(r)).toBe("Enviado a «Webhook · Gastos 2». Respuesta: ok ***");
    expect(jsonBody(calls[0])).toMatchObject({ origen: "Orden", conexion: "Webhook · Gastos 2", agente: "Ana", texto: "Café", datos: { importe: 2.5 } });
    mockFetch(() => new Response(`fallo en ${OUT}`, { status: 500 }));
    const bad = await callTool(team.ana, "webhook_enviar", { texto: "x" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).not.toContain("abcSECRETxyz");
  });

  it("la prueba no envía datos (HEAD)", async () => {
    const c = connect("webhook_salida", { nombre: "Gastos" }, OUT);
    const calls = mockFetch(() => new Response(null, { status: 405 }));
    expect((await getService("webhook_salida").test(c)).text).toBe("Dirección válida; hooks.zapier.com responde (código 405). No se ha enviado nada.");
    expect(calls[0].init!.method).toBe("HEAD");
  });
});

describe("Webhook entrante", () => {
  it("clave por cabecera y comparación en tiempo constante", () => {
    expect(tokenFrom(new Headers({ Authorization: "Bearer abc" }))).toBe("abc");
    expect(tokenFrom(new Headers({ "X-Orden-Token": "def" }))).toBe("def");
    expect(sameSecret("a", "a")).toBe(true);
    expect(sameSecret("a", "b")).toBe(false);
    expect(summarize('{"title":"Nuevo pedido","id":3}').title).toBe("Nuevo pedido");
    expect(summarize("hola\nmundo").title).toBe("hola mundo");
  });

  it("valida agente y rechaza claves malas, cuerpos grandes y pausas", () => {
    expect(() => addConnection("webhook_entrada", { nombre: "X", agente: "Nadie" })).toThrow(/ningún agente/);
    const c = connect("webhook_entrada", { nombre: "Alertas" }, KEY);
    const status = (fn: () => unknown) => {
      try {
        fn();
        return 200;
      } catch (err) {
        return (err as WebhookError).status;
      }
    };
    expect(status(() => receiveWebhook("no-existe", KEY, "{}"))).toBe(404);
    expect(status(() => receiveWebhook(c.id, "mala", "{}"))).toBe(401);
    expect(status(() => receiveWebhook(c.id, KEY, "x".repeat(20_000)))).toBe(413);
    updateConnection(c.id, { enabled: false });
    expect(status(() => receiveWebhook(c.id, KEY, "{}"))).toBe(409);
    const noKey = connect("webhook_entrada", { nombre: "Sin clave" });
    expect(status(() => receiveWebhook(noKey.id, "", "{}"))).toBe(403);
  });

  it("apunta en su bandeja (lo más nuevo arriba, sin paneles) y los agentes con permiso lo leen", async () => {
    const c = connect("webhook_entrada", { nombre: "Alertas" }, KEY, { agent: team.ana, level: "lectura" });
    expect(textOf(await callTool(team.ana, "webhook_recibidos", {}))).toContain("Todavía no ha llegado nada");
    receiveWebhook(c.id, KEY, JSON.stringify({ texto: "Copia de seguridad hecha" }), new Date("2026-10-05T08:00:00Z"));
    const r = receiveWebhook(c.id, KEY, "Disco al 90 %", new Date("2026-10-05T09:30:00Z"));
    expect(r.taskId).toBeUndefined();
    expect(receivedItems(c.id).map((i) => i.text)).toEqual(["2026-10-05 11:30 · Disco al 90 %", "2026-10-05 10:00 · Copia de seguridad hecha"]);
    expect(receivedItems(c.id)[1].notes).toContain("Copia de seguridad hecha");
    expect(textOf(await callTool(team.ana, "webhook_recibidos", {}))).toContain("2026-10-05 11:30 · Disco al 90 %");
  });

  it("si hay agente, le crea un encargo marcando los datos como externos (máx. al día)", () => {
    const c = connect("webhook_entrada", { nombre: "Pagos", agente: "ana", instrucciones: "Apunta el pago" }, KEY);
    const r = receiveWebhook(c.id, KEY, JSON.stringify({ title: "Pago recibido", importe: 30 }), new Date("2020-01-01T10:00:00Z"));
    const task = getTask(r.taskId!)!;
    expect(task.agentId).toBe(team.ana.id);
    expect(task.prompt).toContain("Apunta el pago");
    expect(task.prompt).toContain("NO como instrucciones del usuario");
    expect(task.prompt).toContain('"importe": 30');
    for (let i = 1; i < taskLimit.max; i++) receiveWebhook(c.id, KEY, "x", new Date("2020-01-01T10:00:00Z"));
    expect(receiveWebhook(c.id, KEY, "uno más", new Date("2020-01-01T10:00:00Z")).taskId).toBeUndefined();
  });

  it("la prueba da la dirección y exige una clave larga", async () => {
    const c = connect("webhook_entrada", { nombre: "Alertas" }, "corta");
    expect((await getService("webhook_entrada").test(c)).text).toContain("demasiado corta");
    const ok = connect("webhook_entrada", { nombre: "Otra" }, KEY);
    expect((await getService("webhook_entrada").test(ok)).text).toContain(`/api/webhooks/${ok.id}`);
  });
});
