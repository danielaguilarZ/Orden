import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson, fetchText } from "./http";
import { auditor, cleanText, DailyLimit, guard, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Avisos a un canal de Discord con un webhook del canal (no hace falta bot).
 * Solo texto, sin menciones (@everyone, roles ni usuarios), máx. 1900
 * caracteres y 20 avisos al día. La dirección del webhook va cifrada.
 */

export const MAX_TEXT = 1900;
export const discordLimit = new DailyLimit(20, "avisos por Discord");
const SECRET = "webhook de Discord";

/** Comprueba que es un webhook de Discord (https, dominio oficial, /api/webhooks/<id>/<token>). */
export function checkDiscordUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("La dirección del webhook no es válida.");
  }
  const okHost = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(u.hostname);
  if (u.protocol !== "https:" || !okHost || !/^\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname)) {
    throw new Error("No es un webhook de Discord (https://discord.com/api/webhooks/…).");
  }
  return `${u.origin}${u.pathname}`;
}

export async function sendDiscord(c: Connection, text: string, at = new Date()): Promise<number> {
  const body = cleanText(text, MAX_TEXT, "El aviso");
  const url = checkDiscordUrl(requireSecret(c, SECRET));
  discordLimit.check(c.id, at);
  await fetchText(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: body, username: String(c.config.remitente || "Orden"), allowed_mentions: { parse: [] } }) },
    { secrets: [url] },
  );
  return discordLimit.add(c.id, at);
}

function discordTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  const g = grants.find((x) => x.level === "completo");
  if (!g) return [];
  const c = g.connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Discord");
  return [
    defineTool(
      "aviso_discord",
      `Envía un mensaje de texto al canal de Discord configurado (sin menciones; máx. ${MAX_TEXT} caracteres y ${discordLimit.max} al día). Úsalo solo si te lo piden o para algo importante.`,
      { texto: z.string().min(1).max(MAX_TEXT) },
      async ({ texto }) =>
        run(async () => {
          const n = await sendDiscord(c, texto);
          audit("envía un aviso");
          ctx.note(`Aviso por Discord: ${texto.slice(0, 80)}`, { kind: "discord" });
          return `Aviso enviado a Discord (${n}/${discordLimit.max} hoy).`;
        }),
    ),
  ];
}

registerService({
  key: "discord",
  label: "Discord (webhook)",
  description: "Mensajes a un canal de Discord tuyo con un webhook. Solo texto, sin menciones y con un máximo diario.",
  category: "avisos",
  icon: "🎮",
  levels: {
    lectura: "Lectura: saber que existe el canal (no envía nada)",
    completo: `Completo: enviar mensajes de texto al canal (máx. ${discordLimit.max} al día)`,
  },
  fields: [{ key: "remitente", label: "Nombre del remitente (opcional)", placeholder: "Orden" }],
  supportsSecret: true,
  secretLabel: "Dirección del webhook",
  secretPlaceholder: "https://discord.com/api/webhooks/…",
  steps: [
    "En Discord: ajustes del canal → Integraciones → Webhooks → «Nuevo webhook» → «Copiar URL del webhook».",
    "Pulsa «Añadir» aquí y pega la dirección en la ficha (se guarda cifrada: quien la tenga puede escribir en el canal).",
    "Pulsa «Probar conexión»: comprueba el webhook sin enviar nada.",
    "Da permiso «Completo» solo a los agentes que deban escribir en el canal.",
  ],
  normalizeConfig(input) {
    return { remitente: String(input.remitente ?? "").trim().slice(0, 40) || "Orden" };
  },
  defaultName(config) {
    return config.remitente === "Orden" ? "Discord · avisos" : `Discord · ${String(config.remitente)}`;
  },
  tools: discordTools,
  prompt(grants) {
    return grants.some((g) => g.level === "completo")
      ? `Discord: puedes escribir en el canal configurado con aviso_discord (máx. ${discordLimit.max} al día). Solo si te lo piden o es importante.`
      : "Hay un canal de Discord, pero tu permiso no permite escribir: pídeselo a quien lo tenga.";
  },
  test(c) {
    return testWith(
      c,
      async (secret) => {
        const url = checkDiscordUrl(secret!);
        const w = await fetchJson<{ name?: string; channel_id?: string }>(url, {}, { secrets: [url] });
        return `Webhook «${w.name ?? "?"}» listo (canal ${w.channel_id ?? "?"}). No se ha enviado nada.`;
      },
      SECRET,
    );
  },
});
