import { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../agents/tools";
import { getConnectionSecret, type Connection } from "../repo/connections";
import { logActivity } from "../repo/system";
import { redact } from "../secrets";
import { fetchJson } from "./http";
import { registerService, type AgentGrant } from "./registry";

/**
 * Avisos por Telegram con un bot propio del usuario. Escritura limitada:
 * solo texto, solo al chat configurado, máx. 1000 caracteres y 20 avisos al
 * día por conexión. El token del bot va cifrado y nunca sale en mensajes.
 */

const API = "https://api.telegram.org";
export const DAILY_LIMIT = 20;
export const MAX_TEXT = 1000;

/** Avisos enviados hoy por conexión (el worker es el único proceso que ejecuta herramientas). */
const sentToday = new Map<string, { day: string; n: number }>();
export function resetTelegramLimits() {
  sentToday.clear();
}

function tokenOf(c: Connection): string {
  const token = getConnectionSecret(c.id);
  if (!token) throw new Error("Falta el token del bot: pégalo en la ficha de la conexión.");
  return token;
}

async function call<T>(token: string, method: string, payload: Record<string, unknown> = {}): Promise<T> {
  const r = await fetchJson<{ ok: boolean; result?: T; description?: string }>(
    `${API}/bot${token}/${method}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    { secrets: [token] },
  );
  if (!r.ok) throw new Error(redact(`Telegram: ${r.description ?? "error desconocido"}`, token));
  return r.result as T;
}

/** Envía un aviso respetando el límite diario. Devuelve cuántos van hoy. */
export async function sendNotice(c: Connection, text: string, at = new Date()): Promise<number> {
  const body = text.trim();
  if (!body) throw new Error("El aviso está vacío.");
  if (body.length > MAX_TEXT) throw new Error(`Aviso demasiado largo (máx. ${MAX_TEXT} caracteres).`);
  const day = at.toISOString().slice(0, 10);
  const used = sentToday.get(c.id);
  const n = used?.day === day ? used.n : 0;
  if (n >= DAILY_LIMIT) throw new Error(`Ya se han enviado ${DAILY_LIMIT} avisos hoy: es el máximo diario.`);
  await call(tokenOf(c), "sendMessage", { chat_id: String(c.config.chat_id), text: body, disable_web_page_preview: true });
  sentToday.set(c.id, { day, n: n + 1 });
  return n + 1;
}

function telegramTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  const g = grants.find((x) => x.level === "completo");
  if (!g) return [];
  const c = g.connection;
  return [
    defineTool(
      "aviso_telegram",
      `Envía un aviso de texto al usuario por Telegram (solo a su chat; máx. ${MAX_TEXT} caracteres y ${DAILY_LIMIT} al día). Úsalo solo para lo urgente o si te lo ha pedido.`,
      { texto: z.string().min(1).max(MAX_TEXT) },
      async ({ texto }) => {
        try {
          const n = await sendNotice(c, texto);
          ctx.note(`Aviso por Telegram: ${texto.slice(0, 80)}`, { kind: "telegram" });
          logActivity("conexion", `${ctx.agent.name} envía un aviso por Telegram`, ctx.agent.id, { connectionId: c.id, taskId: ctx.task.id });
          return ok(`Aviso enviado (${n}/${DAILY_LIMIT} hoy).`);
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    ),
  ];
}

registerService({
  key: "telegram",
  label: "Telegram (avisos)",
  description: "Avisos a tu móvil con un bot de Telegram tuyo. Solo texto, solo a tu chat y con un máximo diario.",
  levels: {
    lectura: "Lectura: saber que existe el canal de avisos (no envía nada)",
    completo: `Completo: enviarte avisos de texto a tu chat (máx. ${DAILY_LIMIT} al día)`,
  },
  fields: [{ key: "chat_id", label: "Tu chat_id", placeholder: "123456789" }],
  supportsSecret: true,
  secretLabel: "Token del bot",
  secretPlaceholder: "123456789:AA…",
  steps: [
    "En Telegram, abre @BotFather, envía /newbot y sigue los pasos: al final te da el token del bot.",
    "Abre el chat con tu bot nuevo y envíale /start (si no, no puede escribirte).",
    "Averigua tu chat_id: escribe a @userinfobot y te lo dice.",
    "Aquí: pon el chat_id y pulsa «Añadir»; después pega el token en la ficha (se guarda cifrado) y pulsa «Probar conexión».",
    "Da permiso «Completo» solo a los agentes que deban avisarte (p. ej. Zen).",
  ],
  normalizeConfig(input) {
    const chat = String(input.chat_id ?? "").trim();
    if (!/^-?\d{3,20}$/.test(chat) && !/^@[A-Za-z0-9_]{5,32}$/.test(chat)) throw new Error("El chat_id es un número (p. ej. 123456789) o un @canal.");
    return { chat_id: chat };
  },
  defaultName() {
    return "Telegram · avisos";
  },
  tools: telegramTools,
  prompt(grants) {
    return grants.some((g) => g.level === "completo")
      ? `Avisos por Telegram: puedes escribir al usuario con aviso_telegram (solo texto, máx. ${DAILY_LIMIT} al día). Úsalo solo para lo urgente o si te lo pide; lo normal es responder en Orden.`
      : "Hay un canal de avisos por Telegram, pero tu permiso no permite enviar: pídeselo a quien lo tenga.";
  },
  async test(c) {
    let token: string | null = null;
    try {
      token = tokenOf(c);
      const me = await call<{ username?: string }>(token, "getMe");
      const chat = await call<{ title?: string; first_name?: string; username?: string }>(token, "getChat", { chat_id: String(c.config.chat_id) }).catch(() => null);
      if (!chat) return { ok: false, text: `Bot @${me.username ?? "?"} correcto, pero no encuentra tu chat: envía /start a tu bot y revisa el chat_id.` };
      return { ok: true, text: `Bot @${me.username ?? "?"} listo para avisar a «${chat.title ?? chat.first_name ?? chat.username ?? String(c.config.chat_id)}».` };
    } catch (err) {
      return { ok: false, text: redact((err as Error).message, token) };
    }
  },
});
