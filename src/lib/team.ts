import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tx } from "./db";
import { createAgent, deleteAgent, findAgentByName, getAgent, listAgents, setAgentLocation, updateAgent } from "./repo/agents";
import { deleteRoom, getRoom, listRooms } from "./repo/rooms";
import { assignDesk } from "./rooms";
import { createTask, listTasks, cancelTask, ACTIVE } from "./repo/tasks";
import { logActivity } from "./repo/system";
import { getPersonality, PERSONALITIES } from "./personalities";
import type { Agent, Appearance } from "./types";

/** Datos para crear o editar un agente (formulario y herramienta de Zen). */
export const agentInputSchema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre").max(40),
  specialty: z.string().trim().max(300).default(""),
  instructions: z.string().trim().max(4000).default(""),
  model: z.enum(["haiku", "sonnet", "opus"]).default("haiku"),
  personality: z
    .object({
      preset: z.string().default("sereno"),
      description: z.string().trim().max(500).default(""),
      voice: z.string().trim().max(300).default(""),
    })
    .default({ preset: "sereno", description: "", voice: "" }),
  appearance: z
    .object({
      skin: z.string(),
      hair: z.string(),
      hairStyle: z.enum(["corto", "largo", "moño", "rapado", "rizado", "coleta"]),
      shirt: z.string(),
      pants: z.string(),
      shoes: z.string(),
      accessory: z.enum(["ninguno", "gafas", "barba", "auriculares", "gorro", "pajarita"]),
    })
    .partial()
    .optional(),
});

export type AgentInput = z.input<typeof agentInputSchema>;

const SKINS = ["#ffdbac", "#f1c27d", "#e0ac69", "#c68642", "#8d5524"];
const HAIRS = ["#2b2b2b", "#3b2a20", "#6b4226", "#a0522d", "#e6c35c", "#b0b0b0", "#c0392b"];
const SHIRTS = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#f39c12", "#16a085", "#d35400", "#34495e"];
const STYLES: Appearance["hairStyle"][] = ["corto", "largo", "moño", "rapado", "rizado", "coleta"];
const ACCESSORIES: Appearance["accessory"][] = ["ninguno", "gafas", "auriculares", "gorro", "pajarita", "ninguno"];

/** Apariencia determinista a partir del nombre (sin Math.random). */
export function appearanceFromName(name: string): Appearance {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const at = <T>(arr: T[], salt: number) => arr[(h >>> salt) % arr.length];
  return {
    skin: at(SKINS, 1),
    hair: at(HAIRS, 4),
    hairStyle: at(STYLES, 7),
    shirt: at(SHIRTS, 10),
    pants: at(["#2f3640", "#34495e", "#5d4037", "#7f8c8d"], 13),
    shoes: at(["#1e1e1e", "#5d4037", "#ffffff"], 16),
    accessory: at(ACCESSORIES, 19),
  };
}

/**
 * Contrata un agente: lo crea con un escritorio asignado en una sala común
 * (no se le construye sala propia) y, si su carácter es personalizado,
 * encarga (una sola vez) frases de ambiente propias.
 */
export function hireAgent(raw: AgentInput, createdBy = "user", opts: { building?: string } = {}): Agent {
  const input = agentInputSchema.parse(raw);
  if (findAgentByName(input.name)) throw new Error(`Ya hay un agente llamado ${input.name}.`);
  const agent = tx(() => {
    const preset = getPersonality(input.personality.preset);
    // El agente nace ya con su escritorio asignado (así aparece directamente en esa sala).
    const desk = assignDesk(input.specialty, listAgents(), opts.building);
    const agent = createAgent({
      id: randomUUID(),
      name: input.name,
      specialty: input.specialty,
      instructions: input.instructions,
      model: input.model,
      personality: { preset: preset.key, description: input.personality.description, voice: input.personality.voice },
      appearance: { ...appearanceFromName(input.name), ...input.appearance },
      ambient: preset.ambient,
      roomId: desk.room.id,
      deskSeatId: desk.seatId,
    });
    logActivity("equipo", `${agent.name} se une al equipo (${input.specialty || "sin especialidad"}); su escritorio está en «${desk.room.name}»`, agent.id, {
      createdBy,
    });
    return agent;
  });
  if (input.personality.description) queueAmbientPhrases(agent);
  return agent;
}

export function queueAmbientPhrases(agent: Agent) {
  createTask({
    agentId: agent.id,
    kind: "ambient",
    title: `Frases de ambiente de ${agent.name}`,
    prompt: "ambient",
    createdBy: "system",
  });
}

export type AgentEdit = Partial<AgentInput> & { paused?: boolean; admin?: boolean; locationRoomId?: string | null };

/**
 * Si cambia el nombre, las instrucciones que empiezan por «Eres <nombre>» (las
 * de Zen al crearse) pasan a usar el nuevo, para que el agente no se presente
 * con el antiguo. Devuelve undefined si no hay nada que guardar.
 */
function renamedInstructions(current: Agent, name: string | undefined, instructions: string | undefined): string | undefined {
  const text = instructions ?? current.instructions;
  const renamed = name !== undefined && name.trim() !== current.name;
  const old = `Eres ${current.name},`;
  if (!renamed || !text.startsWith(old)) return instructions;
  return `Eres ${name.trim()},${text.slice(old.length)}`;
}

export function editAgent(id: string, raw: AgentEdit): Agent {
  const current = getAgent(id);
  if (!current) throw new Error("No existe ese agente.");
  // Mover al agente a otra sala (cualquiera; null = la suya). Es presencia, no edición de la ficha.
  if (raw.locationRoomId !== undefined) {
    const target = raw.locationRoomId || null;
    if (target && !getRoom(target)) throw new Error("No existe esa sala.");
    setAgentLocation(id, target === current.roomId ? null : target);
    const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "locationRoomId"));
    if (!Object.keys(rest).length) return getAgent(id)!;
    return editAgent(id, rest);
  }
  // Ojo: el esquema tiene valores por defecto; sin este filtro, editar solo
  // «paused» rellenaría (y borraría) especialidad, instrucciones, modelo…
  const parsed = agentInputSchema.partial().parse(raw);
  const input = Object.fromEntries(Object.entries(parsed).filter(([k]) => Object.hasOwn(raw, k))) as typeof parsed;
  if (input.name && input.name.toLowerCase() !== current.name.toLowerCase() && findAgentByName(input.name)) {
    throw new Error(`Ya hay un agente llamado ${input.name}.`);
  }
  const personalityChanged =
    input.personality &&
    (input.personality.preset !== current.personality.preset || input.personality.description !== current.personality.description);
  const preset = input.personality ? getPersonality(input.personality.preset ?? current.personality.preset) : null;
  const instructions = renamedInstructions(current, input.name, input.instructions);
  const agent = updateAgent(id, {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.specialty !== undefined && { specialty: input.specialty }),
    ...(instructions !== undefined && { instructions }),
    ...(input.model !== undefined && { model: input.model }),
    ...(input.personality && { personality: { ...current.personality, ...input.personality } }),
    ...(input.appearance && { appearance: { ...current.appearance, ...input.appearance } }),
    ...(personalityChanged && preset && { ambient: preset.ambient }),
    ...(raw.paused !== undefined && { paused: raw.paused }),
    // El rol admin solo lo activa el usuario desde la ficha (nunca un agente).
    ...(raw.admin !== undefined && { admin: Boolean(raw.admin) }),
  });
  if (raw.admin !== undefined && Boolean(raw.admin) !== current.admin) {
    logActivity("equipo", `${agent.name} ${raw.admin ? "recibe el rol admin (puede proponer cambios de código)" : "deja de ser admin"}`, agent.id);
  }
  if (personalityChanged && input.personality?.description) queueAmbientPhrases(agent);
  if (raw.paused !== undefined && raw.paused !== current.paused) {
    logActivity("equipo", `${agent.name} ${raw.paused ? "se pone en pausa" : "vuelve al trabajo"}`, agent.id);
  }
  return agent;
}

export function fireAgent(id: string) {
  const agent = getAgent(id);
  if (!agent) return;
  if (agent.isChief) throw new Error(`${agent.name} es el jefe del equipo y no se puede borrar.`);
  for (const t of listTasks({ agentId: id, statuses: ACTIVE })) cancelTask(t.id);
  tx(() => {
    // Su sala propia (agentes antiguos) se va con él; su escritorio queda libre para el siguiente.
    for (const r of listRooms()) if (r.agentId === id) deleteRoom(r.id);
    deleteAgent(id);
    logActivity("equipo", `${agent.name} deja el equipo`, null);
  });
}

export const PERSONALITY_OPTIONS = PERSONALITIES.map((p) => ({ key: p.key, label: p.label, description: p.description }));
