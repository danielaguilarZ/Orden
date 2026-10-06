import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { redact } from "../secrets";
import { fetchText } from "./http";
import { auditor, clip, DailyLimit, guard, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Webhook saliente genérico: los agentes envían un JSON a una dirección
 * tuya (Zapier, Make, n8n, IFTTT, Home Assistant, un script…). Así se
 * conecta con casi cualquier cosa sin integración propia. Solo con permiso
 * completo, máx. 30 envíos al día. La dirección va cifrada.
 */

export const webhookOutLimit = new DailyLimit(30, "envíos por webhook");
const SECRET = "dirección del webhook";
const MAX_TEXT = 4000;

/** ¿Es un host local o de red privada? (ahí se permite http). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "::1") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** https siempre; http solo hacia el propio PC o la red local. */
export function checkWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("La dirección del webhook no es válida.");
  }
  if (u.protocol === "https:") return u.href;
  if (u.protocol === "http:" && isPrivateHost(u.hostname)) return u.href;
  throw new Error("La dirección debe ser https (http solo para tu PC o tu red local).");
}

export async function sendWebhook(c: Connection, agent: string, text: string, data?: Record<string, unknown>, at = new Date()): Promise<string> {
  const url = checkWebhookUrl(requireSecret(c, SECRET));
  const t = text.trim();
  if (!t && !data) throw new Error("No hay nada que enviar.");
  if (t.length > MAX_TEXT) throw new Error(`Texto demasiado largo (máx. ${MAX_TEXT} caracteres).`);
  const body = JSON.stringify({ origen: "Orden", conexion: c.name, agente: agent, texto: t, datos: data ?? {}, enviado: at.toISOString() });
  if (body.length > 20_000) throw new Error("Datos demasiado grandes (máx. 20 KB).");
  webhookOutLimit.check(c.id, at);
  const reply = await fetchText(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, { secrets: [url], maxBytes: 200_000 });
  webhookOutLimit.add(c.id, at);
  return redact(clip(reply.trim(), 500), url);
}

function webhookOutTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  const writable = grants.filter((g) => g.level === "completo");
  if (!writable.length) return [];
  const names = writable.map((g) => `«${g.connection.name}»${g.connection.config.para_que ? ` (${String(g.connection.config.para_que)})` : ""}`);
  return [
    defineTool(
      "webhook_enviar",
      `Envía datos a un webhook del usuario: ${names.join("; ")}. Solo cuando te lo pidan o para lo que indica cada uno. Máx. ${webhookOutLimit.max} al día.`,
      {
        webhook: z.string().max(100).optional().describe("Nombre del webhook (si hay varios)"),
        texto: z.string().max(MAX_TEXT),
        datos: z.record(z.string(), z.unknown()).optional().describe("Campos extra (JSON)"),
      },
      async ({ webhook, texto, datos }) => {
        const g = writable.find((x) => !webhook || x.connection.name.toLowerCase().includes(webhook.toLowerCase())) ?? writable[0];
        const c = g.connection;
        return guard(c)(async () => {
          const reply = await sendWebhook(c, ctx.agent.name, texto, datos);
          auditor(ctx, c, "webhook")("envía datos");
          ctx.note(`Webhook «${c.name}»: enviado`, { kind: "webhook" });
          return `Enviado a «${c.name}».${reply ? ` Respuesta: ${reply}` : ""}`;
        });
      },
    ),
  ];
}

registerService({
  key: "webhook_salida",
  label: "Webhook saliente",
  description: "Envía datos a Zapier, Make, n8n, IFTTT o tus scripts: conecta Orden con casi cualquier servicio. Solo con permiso completo.",
  category: "auto",
  icon: "📤",
  levels: {
    lectura: "Lectura: saber que existe (no envía nada)",
    completo: `Completo: enviar datos al webhook (máx. ${webhookOutLimit.max} al día)`,
  },
  fields: [
    { key: "nombre", label: "Nombre", placeholder: "Añadir gasto a mi hoja" },
    { key: "para_que", label: "Para qué sirve (lo leen los agentes)", placeholder: "Recibe {texto, datos:{importe, concepto}} y lo apunta en Google Sheets" },
  ],
  supportsSecret: true,
  secretLabel: "Dirección del webhook",
  secretPlaceholder: "https://hooks.zapier.com/… o http://localhost:5678/webhook/…",
  steps: [
    "Crea un webhook de entrada en tu herramienta (Zapier «Catch Hook», Make «Custom webhook», n8n «Webhook», IFTTT «Webhooks»…) y copia su dirección.",
    "Aquí: ponle nombre, explica para qué sirve y qué campos espera (los agentes lo leen) y pulsa «Añadir».",
    "Pega la dirección en la ficha (se guarda cifrada). Debe ser https; http solo para tu PC o tu red local.",
    "Orden envía un JSON: {origen, conexion, agente, texto, datos, enviado}. Da «Completo» solo a quien deba usarlo.",
  ],
  normalizeConfig(input) {
    const nombre = String(input.nombre ?? "").trim().slice(0, 60);
    if (!nombre) throw new Error("Ponle un nombre al webhook.");
    return { nombre, para_que: String(input.para_que ?? "").trim().slice(0, 300) };
  },
  defaultName(config) {
    return `Webhook · ${String(config.nombre)}`;
  },
  tools: webhookOutTools,
  prompt(grants) {
    const w = grants.filter((g) => g.level === "completo");
    return w.length
      ? `Webhooks salientes (webhook_enviar): ${w.map((g) => `«${g.connection.name}»${g.connection.config.para_que ? ` — ${String(g.connection.config.para_que)}` : ""}`).join("; ")}. Úsalos solo para lo que indican.`
      : "Hay webhooks salientes, pero tu permiso no permite enviar.";
  },
  test(c) {
    return testWith(
      c,
      async (secret) => {
        const url = checkWebhookUrl(secret!);
        let status = 0;
        try {
          status = (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) })).status;
        } catch (err) {
          throw new Error(redact(`No responde ${new URL(url).host}: ${(err as Error).message}`, url));
        }
        return `Dirección válida; ${new URL(url).host} responde (código ${status}). No se ha enviado nada.`;
      },
      SECRET,
    );
  },
});
