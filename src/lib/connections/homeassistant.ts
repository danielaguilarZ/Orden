import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef } from "../agents/tools";
import type { Connection } from "../repo/connections";
import { fetchJson } from "./http";
import { auditor, clip, DailyLimit, guard, listField, pickGrant, requireSecret, testWith } from "./kit";
import { registerService, type AgentGrant } from "./registry";

/**
 * Home Assistant con un token de larga duración. Lectura: estados de las
 * entidades. Completo: ejecutar SOLO las acciones de la lista blanca (p. ej.
 * «light.turn_on») y, si se indica, solo sobre las entidades permitidas.
 * Máx. 100 acciones al día.
 */

const SECRET = "token de Home Assistant";
export const haLimit = new DailyLimit(100, "acciones en Home Assistant");
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const ACTION = /^[a-z_]+\.[a-z0-9_]+$/;

export interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
}

function api<T>(c: Connection, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = requireSecret(c, SECRET);
  return fetchJson<T>(
    `${String(c.config.url)}${path}`,
    { method: init.method ?? "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    { secrets: [token], maxBytes: 5_000_000 },
  );
}

export function normalizeHa(input: Record<string, unknown>) {
  let u: URL;
  try {
    u = new URL(String(input.url ?? "").trim());
  } catch {
    throw new Error("Escribe la dirección de Home Assistant (p. ej. http://homeassistant.local:8123).");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("La dirección debe ser http(s).");
  const acciones = listField(input.acciones, 30);
  for (const a of acciones) if (!ACTION.test(a)) throw new Error(`Acción no válida: «${a}» (formato dominio.servicio, p. ej. light.turn_on).`);
  const entidades = listField(input.entidades, 100);
  for (const e of entidades) if (!ENTITY.test(e) && !/^[a-z_]+\.\*$/.test(e)) throw new Error(`Entidad no válida: «${e}» (p. ej. light.salon o light.*).`);
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, acciones, entidades };
}

const nameOf = (s: HaState) => String(s.attributes?.friendly_name ?? s.entity_id);
const unitOf = (s: HaState) => (s.attributes?.unit_of_measurement ? ` ${String(s.attributes.unit_of_measurement)}` : "");
export const stateLine = (s: HaState) => `- ${nameOf(s)} (${s.entity_id}): ${s.state}${unitOf(s)}`;

export async function listStates(c: Connection, domain?: string, text?: string, max = 80): Promise<string> {
  const all = await api<HaState[]>(c, "/api/states");
  const t = text?.trim().toLowerCase();
  const list = all
    .filter((s) => !domain || s.entity_id.startsWith(`${domain}.`))
    .filter((s) => !t || s.entity_id.includes(t) || nameOf(s).toLowerCase().includes(t))
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  if (!list.length) return "Ninguna entidad coincide.";
  return [`${list.length} entidad(es)${list.length > max ? ` (se muestran ${max})` : ""}:`, ...list.slice(0, max).map(stateLine)].join("\n");
}

export async function oneState(c: Connection, entity: string): Promise<string> {
  if (!ENTITY.test(entity)) throw new Error("Entidad no válida (p. ej. sensor.temperatura_salon).");
  const s = await api<HaState>(c, `/api/states/${entity}`);
  const attrs = Object.entries(s.attributes ?? {})
    .filter(([k]) => k !== "friendly_name")
    .map(([k, v]) => `  ${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), 200)}`);
  return [stateLine(s), s.last_changed ? `  Último cambio: ${s.last_changed}` : "", ...attrs].filter(Boolean).join("\n");
}

/** ¿Está permitida esta acción sobre esta entidad según la configuración? */
export function actionAllowed(config: Record<string, unknown>, action: string, entity: string): string | null {
  const acciones = (config.acciones as string[] | undefined) ?? [];
  const entidades = (config.entidades as string[] | undefined) ?? [];
  if (!acciones.includes(action)) return `La acción «${action}» no está en la lista permitida (${acciones.join(", ") || "vacía"}). El usuario puede añadirla en Conexiones.`;
  if (entidades.length && !entidades.some((e) => e === entity || (e.endsWith(".*") && entity.startsWith(e.slice(0, -1))))) return `La entidad «${entity}» no está en la lista permitida.`;
  return null;
}

export async function callAction(c: Connection, action: string, entity: string, data: Record<string, unknown> = {}, at = new Date()): Promise<number> {
  if (!ACTION.test(action)) throw new Error("Acción no válida (formato dominio.servicio).");
  if (!ENTITY.test(entity)) throw new Error("Entidad no válida.");
  const denied = actionAllowed(c.config, action, entity);
  if (denied) throw new Error(denied);
  haLimit.check(c.id, at);
  const [domain, service] = action.split(".");
  const changed = await api<HaState[]>(c, `/api/services/${domain}/${service}`, { method: "POST", body: { ...data, entity_id: entity } });
  haLimit.add(c.id, at);
  return Array.isArray(changed) ? changed.length : 0;
}

function haTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const g = pickGrant(grants);
  const c = g.connection;
  const run = guard(c);
  const audit = auditor(ctx, c, "Home Assistant");
  const tools: ToolDef[] = [
    defineTool(
      "casa_estados",
      "Estados de las entidades de Home Assistant (luces, sensores, enchufes…). Filtra por dominio (light, sensor, switch, climate…) o por texto.",
      { dominio: z.string().regex(/^[a-z_]+$/).max(30).optional(), buscar: z.string().max(60).optional(), max: z.number().int().min(1).max(300).optional() },
      async ({ dominio, buscar, max }) =>
        run(async () => {
          audit(`consulta estados${dominio ? ` de ${dominio}` : ""}`);
          return listStates(c, dominio, buscar, max ?? 80);
        }),
    ),
    defineTool("casa_estado", "Estado y atributos de una entidad de Home Assistant.", { entidad: z.string().max(100) }, async ({ entidad }) =>
      run(async () => {
        audit(`consulta ${entidad}`);
        return oneState(c, entidad);
      }),
    ),
  ];
  if (g.level === "completo") {
    const allowed = (c.config.acciones as string[] | undefined) ?? [];
    tools.push(
      defineTool(
        "casa_accion",
        `Ejecuta una acción de Home Assistant sobre una entidad (solo si te lo piden). Permitidas: ${allowed.join(", ") || "ninguna (el usuario debe añadirlas en Conexiones)"}.`,
        {
          accion: z.string().max(60).describe("dominio.servicio, p. ej. light.turn_on"),
          entidad: z.string().max(100),
          datos: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Parámetros extra, p. ej. {brightness_pct: 50}"),
        },
        async ({ accion, entidad, datos }) =>
          run(async () => {
            const n = await callAction(c, accion, entidad, datos ?? {});
            audit(`${accion} en ${entidad}`);
            ctx.note(`Casa: ${accion} en ${entidad}`, { kind: "homeassistant" });
            return `Hecho: ${accion} en ${entidad} (${n} entidad(es) cambiaron).`;
          }),
      ),
    );
  }
  return tools;
}

registerService({
  key: "homeassistant",
  label: "Home Assistant",
  description: "Tu casa domótica: estados de luces, sensores y enchufes; con permiso completo, solo las acciones que tú permitas.",
  category: "hogar",
  icon: "🏠",
  levels: {
    lectura: "Lectura: ver estados y atributos de las entidades",
    completo: `Completo: además ejecutar las acciones de la lista blanca (máx. ${haLimit.max} al día)`,
  },
  fields: [
    { key: "url", label: "Dirección", placeholder: "http://homeassistant.local:8123" },
    { key: "acciones", label: "Acciones permitidas (opcional)", placeholder: "light.turn_on, light.turn_off, scene.turn_on" },
    { key: "entidades", label: "Entidades permitidas (opcional; vacío = todas)", placeholder: "light.*, switch.cafetera" },
  ],
  supportsSecret: true,
  secretLabel: "Token de larga duración",
  secretPlaceholder: "eyJhbGciOi…",
  steps: [
    "En Home Assistant: tu perfil (abajo a la izquierda) → pestaña «Seguridad» → «Tokens de acceso de larga duración» → «Crear token».",
    "Aquí: escribe la dirección de tu Home Assistant y, si quieres que los agentes actúen, las acciones permitidas (p. ej. light.turn_on, light.turn_off). Pulsa «Añadir».",
    "Pega el token en la ficha (se guarda cifrado) y pulsa «Probar conexión».",
    "«Lectura» para consultar; «Completo» para ejecutar solo las acciones de tu lista (y solo sobre las entidades permitidas si las indicas).",
  ],
  normalizeConfig: normalizeHa,
  defaultName() {
    return "Home Assistant";
  },
  tools: haTools,
  prompt(grants) {
    const g = pickGrant(grants);
    const acc = (g.connection.config.acciones as string[] | undefined) ?? [];
    return `Home Assistant (la casa del usuario): casa_estados y casa_estado${g.level === "completo" ? `; casa_accion solo cuando te lo pidan (permitidas: ${acc.join(", ") || "ninguna"})` : ""}.`;
  },
  test(c) {
    return testWith(
      c,
      async () => {
        const cfg = await api<{ location_name?: string; version?: string }>(c, "/api/config");
        const states = await api<HaState[]>(c, "/api/states");
        return `Home Assistant «${cfg.location_name ?? "?"}» (versión ${cfg.version ?? "?"}): ${states.length} entidades.`;
      },
      SECRET,
    );
  },
});
