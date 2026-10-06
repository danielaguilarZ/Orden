import { describe, expect, it } from "vitest";
import { getService } from "@/lib/connections/registry";
import { checkDiscordUrl, discordLimit, sendDiscord } from "@/lib/connections/discord";
import { callTool, connect, jsonBody, mockFetch, promptOf, storedSecret, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const HOOK = "https://discord.com/api/webhooks/123456789012345678/AbCdEf_ghIJ-klmnopQRSTuvwxyz0123456789";
useConnTestEnv(() => discordLimit.reset());

describe("Discord (webhook)", () => {
  it("solo acepta webhooks oficiales por https", () => {
    expect(checkDiscordUrl(`${HOOK}?wait=true`)).toBe(HOOK);
    expect(() => checkDiscordUrl("https://evil.com/api/webhooks/1/x")).toThrow(/No es un webhook/);
    expect(() => checkDiscordUrl(HOOK.replace("https", "http"))).toThrow(/No es un webhook/);
    expect(() => checkDiscordUrl("nada")).toThrow(/no es válida/);
  });

  it("solo con permiso completo; sin menciones; dirección cifrada", async () => {
    const c = connect("discord", {}, HOOK, { agent: team.ana, level: "lectura" });
    expect(storedSecret(c.id)).not.toContain("AbCdEf");
    expect(toolNames(team.ana, "aviso_discord")).toEqual([]);
    expect(promptOf(team.ana)).toContain("no permite escribir");
    connect("discord", { remitente: "Zen" }, HOOK, { agent: team.ana, level: "completo" });
    const calls = mockFetch(() => new Response(null, { status: 204 }));
    const r = await callTool(team.ana, "aviso_discord", { texto: "Hola @everyone" });
    expect(textOf(r)).toBe("Aviso enviado a Discord (1/20 hoy).");
    expect(calls[0].url).toBe(HOOK);
    expect(jsonBody(calls[0])).toEqual({ content: "Hola @everyone", username: "Zen", allowed_mentions: { parse: [] } });
  });

  it("límite diario y errores sin la dirección", async () => {
    const c = connect("discord", {}, HOOK);
    mockFetch(() => new Response(null, { status: 204 }));
    const at = new Date("2020-01-01T10:00:00Z");
    for (let i = 0; i < discordLimit.max; i++) await sendDiscord(c, `n${i}`, at);
    await expect(sendDiscord(c, "otra", at)).rejects.toThrow(/máximo diario/);
    await expect(sendDiscord(c, "x".repeat(2000), new Date("2020-01-02T10:00:00Z"))).rejects.toThrow(/largo/);
    mockFetch(() => new Response(`Unknown Webhook ${HOOK}`, { status: 404 }));
    const t = await getService("discord").test(c);
    expect(t.ok).toBe(false);
    expect(t.text).not.toContain("AbCdEf");
    mockFetch(() => ({ name: "Avisos", channel_id: "42" }));
    expect((await getService("discord").test(c)).text).toBe("Webhook «Avisos» listo (canal 42). No se ha enviado nada.");
  });
});
