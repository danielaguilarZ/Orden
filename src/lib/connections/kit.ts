import { fail, ok, type ToolContext } from "../agents/tools";
import { getConnectionSecret, type Connection } from "../repo/connections";
import { logActivity } from "../repo/system";
import { redact } from "../secrets";
import type { AgentGrant } from "./registry";

/**
 * Piezas comunes de las conexiones sencillas: credencial obligatoria,
 * herramientas que nunca devuelven secretos, registro en Actividad y límite
 * diario de envíos.
 */

/** Credencial descifrada o un error que dice dónde ponerla. */
export function requireSecret(c: Connection, label = "token"): string {
  const s = getConnectionSecret(c.id);
  if (!s) throw new Error(`Falta el ${label}: pégalo en la ficha de la conexión.`);
  return s;
}

/** La credencial para taparla en mensajes (null si no hay o no se puede leer). */
function secretFor(c: Connection): string | null {
  try {
    return getConnectionSecret(c.id);
  } catch {
    return null;
  }
}

/**
 * Ejecutor de herramientas de una conexión: el texto si va bien; si falla,
 * el error sin la credencial de la conexión (ni formatos de token conocidos).
 */
export function guard(c: Connection) {
  return async (fn: () => Promise<string>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(redact((err as Error).message, secretFor(c)));
    }
  };
}

/** Deja constancia en Actividad de lo que hace un agente con una conexión. */
export function auditor(ctx: ToolContext, c: Connection, service: string) {
  return (text: string) => logActivity("conexion", `${ctx.agent.name} en ${service}: ${text}`, ctx.agent.id, { connectionId: c.id, taskId: ctx.task.id });
}

/** La conexión con permiso «completo» si la hay; si no, la primera. */
export const pickGrant = (grants: AgentGrant[]) => grants.find((g) => g.level === "completo") ?? grants[0];

/** Hay alguna con permiso «completo». */
export const canWrite = (grants: AgentGrant[]) => grants.some((g) => g.level === "completo");

/** «Comprobar acceso» común: texto si va bien; si falla, el error sin secretos. */
export async function testWith(c: Connection, fn: (secret: string | null) => Promise<string>, label?: string): Promise<{ ok: boolean; text: string }> {
  let secret: string | null = null;
  try {
    secret = label ? requireSecret(c, label) : getConnectionSecret(c.id);
    return { ok: true, text: await fn(secret) };
  } catch (err) {
    return { ok: false, text: redact((err as Error).message, secret) };
  }
}

/**
 * Límite de envíos al día por conexión. Vive en memoria del proceso que
 * ejecuta las herramientas (el worker); al reiniciar, empieza de cero.
 */
export class DailyLimit {
  private used = new Map<string, { day: string; n: number }>();
  constructor(
    readonly max: number,
    private readonly what = "envíos",
  ) {}

  /** Comprueba que queda cupo (lanza si no) y devuelve cuántos van hoy. */
  check(id: string, at = new Date()): number {
    const day = at.toISOString().slice(0, 10);
    const u = this.used.get(id);
    const n = u?.day === day ? u.n : 0;
    if (n >= this.max) throw new Error(`Ya se han hecho ${this.max} ${this.what} hoy: es el máximo diario.`);
    return n;
  }

  /** Apunta uno más (después de enviarlo bien). */
  add(id: string, at = new Date()): number {
    const n = this.check(id, at) + 1;
    this.used.set(id, { day: at.toISOString().slice(0, 10), n });
    return n;
  }

  reset() {
    this.used.clear();
  }
}

/** Texto obligatorio, recortado y con longitud máxima. */
export function cleanText(text: string, max: number, what = "El mensaje"): string {
  const t = text.trim();
  if (!t) throw new Error(`${what} está vacío.`);
  if (t.length > max) throw new Error(`${what} es demasiado largo (máx. ${max} caracteres).`);
  return t;
}

/** Lista de textos de un campo de configuración («a, b» o array). */
export function listField(input: unknown, max = 50): string[] {
  const raw = Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[,\n]+/);
  const out: string[] = [];
  for (const r of raw) {
    const s = r.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > max) throw new Error(`Demasiados elementos (máx. ${max}).`);
  return out;
}

/** Recorta un texto largo para devolverlo a un agente. */
export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
