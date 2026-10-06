import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { redact } from "../secrets";
import { fetchText } from "./http";
import { auditor, cleanText, DailyLimit, guard, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Avisos a un canal de Slack con un «Incoming Webhook». Solo texto (sin
 * @channel/@here), máx. 3000 caracteres y 20 al día. La dirección va cifrada.
 */

export const MAX_TEXT = 3000;
export const slackLimit = new DailyLimit(20, "avisos por Slack");
const SECRET = "webhook de Slack";

export function checkSlackUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("La dirección del webhook no es válida.");
  }
  if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com" || !/^\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/.test(u.pathname)) {
    throw new Error("No es un webhook de Slack (https://hooks.slack.com/services/…).");
  }
  return u.href;
}

/** Sin menciones masivas: «<!channel>», «<!here>», «<!everyone>» y «@channel»/«@here» pasan a texto. */
export const defuse = (s: string) => s.replace(/<!(channel|here|everyone)[^>]*>/gi, "@$1").replace(/@(channel|here|everyone)\b/gi, "@​$1");

export async function sendSlack(c: Connection, text: string, at = new Date()): Promise<number> {
  const body = defuse(cleanText(text, MAX_TEXT, "El aviso"));
  const url = checkSlackUrl(requireSecret(c, SECRET));
  slackLimit.check(c.id, at);
  await fetchText(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: body }) }, { secrets: [url] });
  return slackLimit.add(c.id, at);
}

/**
 * Comprueba el webhook sin publicar: un cuerpo vacío devuelve 400
 * «no_text» si la dirección es buena, y 403/404 si no.
 */
export async function probeSlack(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(redact(`No se pudo conectar con Slack: ${(err as Error).message}`, url));
  }
  const text = (await res.text()).slice(0, 100);
  if (res.status === 400 && /no_text|missing_text/.test(text)) return "Webhook de Slack válido. No se ha enviado nada.";
  throw new Error(redact(`Slack rechaza el webhook (${res.status}: ${text}).`, url));
}

function slackTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  const g = grants.find((x) => x.level === "completo");
  if (!g) return [];
  const c = g.connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Slack");
  return [
    defineTool(
      "aviso_slack",
      `Envía un mensaje al canal de Slack configurado (admite formato mrkdwn; sin @channel; máx. ${MAX_TEXT} caracteres y ${slackLimit.max} al día). Solo si te lo piden o es importante.`,
      { texto: z.string().min(1).max(MAX_TEXT) },
      async ({ texto }) =>
        run(async () => {
          const n = await sendSlack(c, texto);
          audit("envía un aviso");
          ctx.note(`Aviso por Slack: ${texto.slice(0, 80)}`, { kind: "slack" });
          return `Aviso enviado a Slack (${n}/${slackLimit.max} hoy).`;
        }),
    ),
  ];
}

registerService({
  key: "slack",
  label: "Slack (webhook)",
  description: "Mensajes a un canal de Slack con un Incoming Webhook. Solo texto, sin menciones masivas y con un máximo diario.",
  category: "avisos",
  icon: "💼",
  levels: {
    lectura: "Lectura: saber que existe el canal (no envía nada)",
    completo: `Completo: enviar mensajes al canal (máx. ${slackLimit.max} al día)`,
  },
  fields: [{ key: "canal", label: "Canal (solo para reconocerlo)", placeholder: "#avisos" }],
  supportsSecret: true,
  secretLabel: "Dirección del webhook",
  secretPlaceholder: "https://hooks.slack.com/services/…",
  steps: [
    "En api.slack.com/apps → «Create New App» (From scratch) en tu espacio de trabajo.",
    "«Incoming Webhooks» → actívalos → «Add New Webhook to Workspace» → elige el canal → copia la dirección.",
    "Pulsa «Añadir» aquí y pega la dirección en la ficha (se guarda cifrada).",
    "Pulsa «Probar conexión»: comprueba el webhook sin publicar nada. Da «Completo» a quien deba escribir.",
  ],
  normalizeConfig(input) {
    return { canal: String(input.canal ?? "").trim().slice(0, 60) };
  },
  defaultName(config) {
    return config.canal ? `Slack · ${String(config.canal)}` : "Slack · avisos";
  },
  tools: slackTools,
  prompt(grants) {
    return grants.some((g) => g.level === "completo")
      ? `Slack: puedes escribir en el canal configurado con aviso_slack (máx. ${slackLimit.max} al día). Solo si te lo piden o es importante.`
      : "Hay un canal de Slack, pero tu permiso no permite escribir: pídeselo a quien lo tenga.";
  },
  test(c) {
    return testWith(c, async (secret) => probeSlack(checkSlackUrl(secret!)), SECRET);
  },
});
