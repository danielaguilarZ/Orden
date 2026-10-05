import { buildingOf, computeWalkways, roomsConnected } from "./house";
import { BUILDINGS } from "../lib/roomTemplates";
import type { Agent, Room } from "../lib/types";

/**
 * ¿Se puede borrar una sala? Lógica pura: la usan el editor de sala (para
 * avisar antes de pedir confirmación) y el servidor (para hacerla cumplir).
 *
 * - Nunca la última sala de un edificio.
 * - Nunca la sala propia de un agente (lo dejaría sin sitio).
 * - Nunca si parte el edificio (salas sin puerta para llegar) o deja un
 *   edificio sin pasarela.
 * - Los agentes con su escritorio asignado aquí se reubican en otro puesto
 *   libre (como al contratar), pero solo si se confirma (`relocate`).
 * - Quien solo está de visita vuelve a su sitio.
 */
export interface RoomRemovalCheck {
  /** Motivo por el que no se puede borrar (null = se puede). */
  blocked: string | null;
  /** Agentes con su escritorio aquí: se les asignará otro puesto. */
  relocate: Pick<Agent, "id" | "name">[];
  /** Agentes que solo están de visita: vuelven a su sitio. */
  visitors: Pick<Agent, "id" | "name">[];
}

type AgentRef = Pick<Agent, "id" | "name" | "roomId" | "locationRoomId">;

/** «Ana», «Ana y Leo», «Ana, Leo y Pol». */
export function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

export function checkRoomRemoval(room: Room, rooms: Room[], agents: AgentRef[]): RoomRemovalCheck {
  const building = buildingOf(room);
  const label = BUILDINGS[building]?.label ?? building;
  const rest = rooms.filter((r) => r.id !== room.id);
  const siblings = rest.filter((r) => buildingOf(r) === building);
  const visitors = agents.filter((a) => a.locationRoomId === room.id && a.roomId !== room.id).map(({ id, name }) => ({ id, name }));
  const block = (blocked: string): RoomRemovalCheck => ({ blocked, relocate: [], visitors });

  if (!siblings.length) return block(`Es la última sala de ${label}: no se puede borrar.`);

  const owner = room.agentId ? agents.find((a) => a.id === room.agentId) : undefined;
  if (owner) return block(`Es la sala propia de ${owner.name}: borrarla le dejaría sin sitio.`);

  if (!roomsConnected(siblings)) {
    return block(`Separaría ${label} en dos: alguna sala se quedaría sin puerta para llegar. Borra antes las salas de los extremos.`);
  }
  const before = new Set(computeWalkways(rooms).map((w) => w.id));
  const after = new Set(computeWalkways(rest).map((w) => w.id));
  const lost = [...before].filter((id) => !after.has(id));
  if (lost.length) return block("Es la sala por la que entra la pasarela entre los edificios y no hay otra por la que pueda entrar.");

  const relocate = agents.filter((a) => a.roomId === room.id).map(({ id, name }) => ({ id, name }));
  return { blocked: null, relocate, visitors };
}
