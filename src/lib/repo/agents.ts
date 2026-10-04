import { randomUUID } from "node:crypto";
import { getDb, now, parseJson, tx } from "../db";
import { emit } from "../events";
import type { Agent, AgentStatus, Appearance, ModelChoice, Personality } from "../types";

interface AgentRow {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
  model: string;
  personality: string;
  appearance: string;
  ambient: string;
  is_chief: number;
  admin: number;
  paused: number;
  status: string;
  status_text: string;
  room_id: string | null;
  location_room_id: string | null;
  desk_seat_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  skin: "#f1c27d",
  hair: "#3b2a20",
  hairStyle: "corto",
  shirt: "#4f7cac",
  pants: "#2f3640",
  shoes: "#1e1e1e",
  accessory: "ninguno",
};

function toAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    name: r.name,
    specialty: r.specialty,
    instructions: r.instructions,
    model: r.model as ModelChoice,
    personality: parseJson<Personality>(r.personality, { preset: "sereno", description: "", voice: "" }),
    appearance: { ...DEFAULT_APPEARANCE, ...parseJson<Partial<Appearance>>(r.appearance, {}) },
    ambient: parseJson<string[]>(r.ambient, []),
    isChief: r.is_chief === 1,
    admin: r.admin === 1,
    paused: r.paused === 1,
    status: r.status as AgentStatus,
    statusText: r.status_text,
    roomId: r.room_id,
    locationRoomId: r.location_room_id ?? null,
    deskSeatId: r.desk_seat_id ?? null,
    sessionId: r.session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listAgents(): Agent[] {
  const rows = getDb().prepare("SELECT * FROM agents ORDER BY is_chief DESC, created_at").all() as unknown as AgentRow[];
  return rows.map(toAgent);
}

export function getAgent(id: string): Agent | null {
  const row = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export function findAgentByName(name: string): Agent | null {
  const row = getDb()
    .prepare("SELECT * FROM agents WHERE lower(name) = lower(?)")
    .get(name.trim()) as unknown as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export function getChief(): Agent | null {
  const row = getDb().prepare("SELECT * FROM agents WHERE is_chief = 1 LIMIT 1").get() as unknown as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export interface NewAgent {
  id?: string;
  name: string;
  specialty?: string;
  instructions?: string;
  model?: ModelChoice;
  personality?: Personality;
  appearance?: Partial<Appearance>;
  ambient?: string[];
  isChief?: boolean;
  roomId?: string | null;
  deskSeatId?: string | null;
}

export function createAgent(input: NewAgent): Agent {
  const id = input.id ?? randomUUID();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO agents (id, name, specialty, instructions, model, personality, appearance, ambient,
        is_chief, paused, status, status_text, room_id, desk_seat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'idle', '', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim(),
      input.specialty ?? "",
      input.instructions ?? "",
      input.model ?? "haiku",
      JSON.stringify(input.personality ?? { preset: "sereno", description: "", voice: "" }),
      JSON.stringify({ ...DEFAULT_APPEARANCE, ...input.appearance }),
      JSON.stringify(input.ambient ?? []),
      input.isChief ? 1 : 0,
      input.roomId ?? null,
      input.deskSeatId ?? null,
      ts,
      ts,
    );
  const agent = getAgent(id)!;
  emit("agent.created", agent);
  return agent;
}

export type AgentPatch = Partial<
  Pick<Agent, "name" | "specialty" | "instructions" | "model" | "personality" | "appearance" | "ambient" | "paused" | "admin" | "roomId" | "deskSeatId" | "sessionId">
>;

export function updateAgent(id: string, patch: AgentPatch): Agent {
  return tx(() => {
    const current = getAgent(id);
    if (!current) throw new Error(`No existe el agente ${id}`);
    const next = { ...current, ...patch };
    getDb()
      .prepare(
        `UPDATE agents SET name = ?, specialty = ?, instructions = ?, model = ?, personality = ?, appearance = ?,
          ambient = ?, paused = ?, admin = ?, room_id = ?, desk_seat_id = ?, session_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name.trim(),
        next.specialty,
        next.instructions,
        next.model,
        JSON.stringify(next.personality),
        JSON.stringify(next.appearance),
        JSON.stringify(next.ambient),
        next.paused ? 1 : 0,
        next.admin ? 1 : 0,
        next.roomId,
        next.deskSeatId,
        next.sessionId,
        now(),
        id,
      );
    const agent = getAgent(id)!;
    emit("agent.updated", agent);
    return agent;
  });
}

/** Estado visible en el living. No toca updated_at para no ensuciar la ficha. */
export function setAgentStatus(id: string, status: AgentStatus, statusText = "") {
  getDb().prepare("UPDATE agents SET status = ?, status_text = ? WHERE id = ?").run(status, statusText, id);
  emit("agent.status", { id, status, statusText });
}

/**
 * Cambia la sala en la que está el agente (null = vuelve a la suya). No toca
 * updated_at: es presencia en el living, no una edición de la ficha.
 */
export function setAgentLocation(id: string, roomId: string | null): Agent {
  const res = getDb().prepare("UPDATE agents SET location_room_id = ? WHERE id = ?").run(roomId, id);
  if (!res.changes) throw new Error(`No existe el agente ${id}`);
  const agent = getAgent(id)!;
  emit("agent.updated", agent);
  return agent;
}

export function deleteAgent(id: string) {
  const agent = getAgent(id);
  if (!agent) return;
  if (agent.isChief) throw new Error("Zen es el jefe del equipo y no se puede borrar.");
  getDb().prepare("DELETE FROM agents WHERE id = ?").run(id);
  emit("agent.deleted", { id });
}
