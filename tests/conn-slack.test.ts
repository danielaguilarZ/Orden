import { describe, expect, it } from "vitest";
import { getService } from "@/lib/connections/registry";
import { checkSlackUrl, defuse, slackLimit } from "@/lib/connections/slack";
import { callTool, connect, jsonBody, mockFetch, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const HOOK = "https://hooks.slack.com/services/T0123ABCD/B0456EFGH/abcdefghijklmnopqrstuvwx";
useConnTestEnv(() => slackLimit.reset());

describe("Slack (webhook)", () => {
  it("valida la dirección y desactiva menciones masivas", () => {
    expect(checkSlackUrl(HOOK)).toBe(HOOK);
    expect(() => checkSlackUrl("https://hooks.slack.com.evil.io/services/T/B/x")).toThrow(/No es un webhook/);
    expect(defuse("Ojo <!channel> y @here")).toBe("Ojo @​channel y @​here");
  });

  it("envía solo con permiso completo", async () => {
    connect("slack", { canal: "#avisos" }, HOOK, { agent: team.ana, level: "lectura" });
    expect(toolNames(team.ana, "aviso_slack")).toEqual([]);
    connect("slack", { canal: "#general" }, HOOK, { agent: team.ana, level: "completo" });
    const calls = mockFetch(() => "ok");
    expect(textOf(await callTool(team.ana, "aviso_slack", { texto: "*Hecho*" }))).toBe("Aviso enviado a Slack (1/20 hoy).");
    expect(jsonBody(calls[0])).toEqual({ text: "*Hecho*" });
  });

  it("la prueba no publica: 400 no_text = válido; 403 = inválido, sin la dirección", async () => {
    const c = connect("slack", {}, HOOK);
    const calls = mockFetch(() => new Response("no_text", { status: 400 }));
    expect((await getService("slack").test(c)).text).toBe("Webhook de Slack válido. No se ha enviado nada.");
    expect(calls[0].init!.body).toBe("{}");
    mockFetch(() => new Response(`invalid_token ${HOOK}`, { status: 403 }));
    const t = await getService("slack").test(c);
    expect(t.ok).toBe(false);
    expect(t.text).toContain("403");
    expect(t.text).not.toContain("abcdefghijklmnop");
  });
});
