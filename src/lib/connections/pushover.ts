import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson } from "./http";
import { auditor, cleanText, DailyLimit, guard, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Notificaciones push con Pushover. La clave de usuario va en la
 * configuración y el token de la aplicación, cifrado. Solo envío (máx. 1024
 * caracteres y 30 al día); sin prioridad de emergencia.
 */

const API = "https://api.pushover.net/1";
export const MAX_TEXT = 1024;
export const pushoverLimit = new DailyLimit(30, "avisos por Pushover");
const SECRET = "token de la aplicación de Pushover";

type PushoverReply = { status: number; errors?: string[]; devices?: string[] };

async function post(c: Connection, path: string, payload: Record<string, unknown>): Promise<PushoverReply> {
  const token = requireSecret(c, SECRET);
  const r = await fetchJson<PushoverReply>(
    `${API}${path}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, user: String(c.config.usuario), ...payload }) },
    { secrets: [token] },
  );
  if (r.status !== 1) throw new Error(`Pushover: ${(r.errors ?? ["error desconocido"]).join("; ")}`);
  return r;
}

export async function sendPushover(c: Connection, a: { texto: string; titulo?: string; prioridad?: number; enlace?: string }, at = new Date()): Promise<number> {
  const message = cleanText(a.texto, MAX_TEXT, "El aviso");
  pushoverLimit.check(c.id, at);
  const payload: Record<string, unknown> = { message };
  if (a.titulo?.trim()) payload.title = a.titulo.trim().slice(0, 250);
  if (a.prioridad !== undefined) payload.priority = Math.max(-2, Math.min(1, a.prioridad));
  if (a.enlace?.trim()) {
    if (!/^https?:\/\//.test(a.enlace.trim())) throw new Error("El enlace debe empezar por http(s)://");
    payload.url = a.enlace.trim();
  }
  await post(c, "/messages.json", payload);
  return pushoverLimit.add(c.id, at);
}

function pushoverTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  const g = grants.find((x) => x.level === "completo");
  if (!g) return [];
  const c = g.connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Pushover");
  return [
    defineTool(
      "aviso_pushover",
      `Envía una notificación push al usuario por Pushover (máx. ${MAX_TEXT} caracteres y ${pushoverLimit.max} al día). Prioridad -2 (silenciosa) a 1 (alta). Solo si te lo piden o es importante.`,
      {
        texto: z.string().min(1).max(MAX_TEXT),
        titulo: z.string().max(250).optional(),
        prioridad: z.number().int().min(-2).max(1).optional(),
        enlace: z.string().max(500).optional(),
      },
      async (a) =>
        run(async () => {
          const n = await sendPushover(c, a);
          audit("envía un aviso");
          ctx.note(`Aviso por Pushover: ${a.texto.slice(0, 80)}`, { kind: "pushover" });
          return `Aviso enviado (${n}/${pushoverLimit.max} hoy).`;
        }),
    ),
  ];
}

registerService({
  key: "pushover",
  label: "Pushover (push al móvil)",
  description: "Notificaciones push a tus dispositivos con Pushover. Solo envío, con un máximo diario.",
  category: "avisos",
  icon: "🔔",
  levels: {
    lectura: "Lectura: saber que existe el canal (no envía nada)",
    completo: `Completo: enviarte notificaciones (máx. ${pushoverLimit.max} al día)`,
  },
  fields: [{ key: "usuario", label: "Tu clave de usuario (User Key)", placeholder: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG" }],
  supportsSecret: true,
  secretLabel: "Token de la aplicación",
  secretPlaceholder: "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
  steps: [
    "Entra en pushover.net: tu «User Key» está arriba a la derecha. Cópiala aquí y pulsa «Añadir».",
    "En pushover.net/apps/build crea una aplicación «Orden» y copia su «API Token».",
    "Pega el token en la ficha (se guarda cifrado) y pulsa «Probar conexión»: valida usuario y dispositivos sin enviar nada.",
    "Da «Completo» a quien deba avisarte.",
  ],
  normalizeConfig(input) {
    const usuario = String(input.usuario ?? "").trim();
    if (!/^[A-Za-z0-9]{30}$/.test(usuario)) throw new Error("La clave de usuario de Pushover son 30 letras y números.");
    return { usuario };
  },
  defaultName() {
    return "Pushover · avisos";
  },
  tools: pushoverTools,
  prompt(grants) {
    return grants.some((g) => g.level === "completo")
      ? `Pushover: puedes avisar al usuario con aviso_pushover (máx. ${pushoverLimit.max} al día). Solo lo importante o lo que te pida.`
      : "Hay un canal de avisos por Pushover, pero tu permiso no permite enviar.";
  },
  test(c) {
    return testWith(
      c,
      async () => {
        const r = await post(c, "/users/validate.json", {});
        return `Pushover listo: ${r.devices?.length ?? 0} dispositivo(s) (${(r.devices ?? []).join(", ") || "ninguno"}). No se ha enviado nada.`;
      },
      SECRET,
    );
  },
});
