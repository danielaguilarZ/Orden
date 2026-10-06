import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import { getConnectionSecret, type Connection } from "../repo/connections";
import { fetchJson, fetchText } from "./http";
import { auditor, cleanText, DailyLimit, guard, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Notificaciones push con ntfy (ntfy.sh o tu propio servidor). Completo:
 * enviar avisos al tema (máx. 30 al día). Lectura: leer lo que se ha
 * publicado en el tema (p. ej. notas que te mandas desde el móvil). El token
 * de acceso es opcional (temas protegidos) y va cifrado.
 */

export const MAX_TEXT = 2000;
export const ntfyLimit = new DailyLimit(30, "avisos por ntfy");

const authHeaders = (c: Connection): Record<string, string> => {
  const token = getConnectionSecret(c.id);
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** Servidor (https) y tema válidos. */
export function normalizeNtfy(input: Record<string, unknown>): { servidor: string; tema: string } {
  const raw = String(input.servidor ?? "").trim() || "https://ntfy.sh";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Dirección del servidor no válida.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("El servidor debe ser http(s).");
  const tema = String(input.tema ?? "").trim();
  if (!/^[\w-]{1,64}$/.test(tema)) throw new Error("El tema solo admite letras, números, «-» y «_» (máx. 64).");
  return { servidor: u.origin, tema };
}

export interface NtfyNotice {
  texto: string;
  titulo?: string;
  prioridad?: number;
  etiquetas?: string[];
}

export async function sendNtfy(c: Connection, n: NtfyNotice, at = new Date()): Promise<number> {
  const message = cleanText(n.texto, MAX_TEXT, "El aviso");
  ntfyLimit.check(c.id, at);
  const body: Record<string, unknown> = { topic: String(c.config.tema), message };
  if (n.titulo?.trim()) body.title = n.titulo.trim().slice(0, 120);
  if (n.prioridad) body.priority = n.prioridad;
  if (n.etiquetas?.length) body.tags = n.etiquetas.slice(0, 5);
  await fetchText(`${String(c.config.servidor)}/`, { method: "POST", headers: { ...authHeaders(c), "Content-Type": "application/json" }, body: JSON.stringify(body) }, { secrets: [getConnectionSecret(c.id)] });
  return ntfyLimit.add(c.id, at);
}

interface NtfyMessage {
  event: string;
  time: number;
  title?: string;
  message?: string;
}

/** Mensajes publicados en el tema en las últimas `hours` horas (sin esperar a nuevos). */
export async function readNtfy(c: Connection, hours = 24, max = 30): Promise<string> {
  const q = new URLSearchParams({ poll: "1", since: `${Math.min(72, Math.max(1, hours))}h` });
  const text = await fetchText(`${String(c.config.servidor)}/${String(c.config.tema)}/json?${q}`, { headers: authHeaders(c) }, { secrets: [getConnectionSecret(c.id)], maxBytes: 1_000_000 });
  const msgs = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as NtfyMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is NtfyMessage => m?.event === "message")
    .slice(-max);
  if (!msgs.length) return `No hay mensajes en «${String(c.config.tema)}» en las últimas ${hours} h.`;
  return msgs.map((m) => `- ${new Date(m.time * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · ${m.title ? `${m.title}: ` : ""}${m.message ?? ""}`).join("\n");
}

function ntfyTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = grants.find((x) => x.level === "completo") ?? grants[0];
  const c = g.connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "ntfy");
  const tools: ToolDef[] = [
    defineTool(
      "ntfy_mensajes",
      `Lee los mensajes publicados en el tema de ntfy «${String(c.config.tema)}» (p. ej. notas que el usuario se manda desde el móvil).`,
      { horas: z.number().int().min(1).max(72).optional().describe("Por defecto 24"), max: z.number().int().min(1).max(100).optional() },
      async ({ horas, max }) =>
        run(async () => {
          audit("lee el tema");
          return readNtfy(c, horas ?? 24, max ?? 30);
        }),
    ),
  ];
  if (g.level === "completo") {
    tools.push(
      defineTool(
        "aviso_ntfy",
        `Envía una notificación push al móvil del usuario por ntfy (máx. ${MAX_TEXT} caracteres y ${ntfyLimit.max} al día). Prioridad 1 (mínima) a 5 (urgente; solo si lo es). Solo si te lo piden o es importante.`,
        {
          texto: z.string().min(1).max(MAX_TEXT),
          titulo: z.string().max(120).optional(),
          prioridad: z.number().int().min(1).max(5).optional(),
          etiquetas: z.array(z.string().max(30)).max(5).optional().describe("Etiquetas o emojis de ntfy, p. ej. «warning», «calendar»"),
        },
        async (a) =>
          run(async () => {
            const n = await sendNtfy(c, a);
            audit("envía un aviso");
            ctx.note(`Aviso por ntfy: ${a.texto.slice(0, 80)}`, { kind: "ntfy" });
            return `Aviso enviado (${n}/${ntfyLimit.max} hoy).`;
          }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "ntfy",
  label: "ntfy (push al móvil)",
  description: "Notificaciones push a tu móvil con ntfy, gratis y sin cuenta. También permite leer lo que te mandas al tema.",
  category: "avisos",
  levels: {
    lectura: "Lectura: leer los mensajes del tema",
    completo: `Completo: además enviarte notificaciones (máx. ${ntfyLimit.max} al día)`,
  },
  fields: [
    { key: "tema", label: "Tema (inventa uno difícil de adivinar)", placeholder: "orden-dani-7f3k2" },
    { key: "servidor", label: "Servidor (opcional)", placeholder: "https://ntfy.sh" },
  ],
  supportsSecret: true,
  secretOptional: true,
  secretLabel: "Token de acceso",
  secretPlaceholder: "tk_…",
  steps: [
    "Instala la app ntfy (Android/iOS) y suscríbete a un tema con un nombre difícil de adivinar (en ntfy.sh, quien sepa el nombre puede leerlo).",
    "Aquí: escribe ese tema (y tu servidor si no usas ntfy.sh) y pulsa «Añadir».",
    "Solo si tu tema está protegido: pega un token de acceso (tk_…) en la ficha; se guarda cifrado.",
    "Pulsa «Probar conexión» y da «Completo» a quien deba avisarte (p. ej. Zen).",
  ],
  normalizeConfig: normalizeNtfy,
  defaultName(config) {
    return `ntfy · ${String(config.tema)}`;
  },
  tools: ntfyTools,
  prompt(grants) {
    return grants.some((g) => g.level === "completo")
      ? `ntfy: puedes avisar al móvil del usuario con aviso_ntfy (máx. ${ntfyLimit.max} al día; solo lo importante o lo que te pida) y leer el tema con ntfy_mensajes.`
      : "ntfy: lee los mensajes del tema del usuario con ntfy_mensajes (no puedes enviar avisos).";
  },
  test(c) {
    return testWith(c, async () => {
      const h = await fetchJson<{ healthy?: boolean }>(`${String(c.config.servidor)}/v1/health`, { headers: authHeaders(c) });
      if (h.healthy === false) throw new Error("El servidor de ntfy dice que no está sano.");
      await readNtfy(c, 1, 1);
      return `Servidor ${new URL(String(c.config.servidor)).host} en marcha y tema «${String(c.config.tema)}» accesible. No se ha enviado nada.`;
    });
  },
});
