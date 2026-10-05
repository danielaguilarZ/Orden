import { FURNITURE, footprint } from "./furniture";
import type { Agent, FurnitureItem, Room } from "../lib/types";

/**
 * Presencia en la casa. Todas las salas son de todos: cada agente tiene un
 * sitio de referencia (su sala propia, en los agentes antiguos, o la sala
 * común donde está su escritorio asignado), pero puede estar, trabajar y
 * decorar en cualquiera. Puro: lo usan el living, la interfaz y el servidor.
 */

/** ¿Este asiento está junto a un escritorio (a una baldosa como mucho)? */
export function isNearDesk(seat: Pick<FurnitureItem, "x" | "y">, furniture: FurnitureItem[]): boolean {
  return furniture.some((o) => {
    if (!FURNITURE[o.kind]?.desk) return false;
    const fp = footprint(o.kind, o.flip);
    return seat.x >= o.x - 1 && seat.x <= o.x + fp.w && seat.y >= o.y - 1 && seat.y <= o.y + fp.d;
  });
}

/** Sillas de los puestos de una sala: asientos (no camas) junto a un escritorio. */
export function deskSeats(furniture: FurnitureItem[]): FurnitureItem[] {
  return furniture.filter((f) => {
    const def = FURNITURE[f.kind];
    return Boolean(def?.seat && !def.bed) && isNearDesk(f, furniture);
  });
}

/** Primera silla de puesto de la sala que no tiene asignada ningún agente. */
export function freeDeskSeat(room: Pick<Room, "furniture">, agents: Pick<Agent, "deskSeatId">[]): FurnitureItem | undefined {
  const taken = new Set(agents.map((a) => a.deskSeatId).filter(Boolean));
  return deskSeats(room.furniture).find((f) => !taken.has(f.id));
}

/** Sala en la que está ahora el agente: donde se ha movido, si no la suya y si no la primera. */
export function currentRoom(agent: Pick<Agent, "roomId" | "locationRoomId">, rooms: Room[]): Room | undefined {
  return (
    (agent.locationRoomId ? rooms.find((r) => r.id === agent.locationRoomId) : undefined) ??
    (agent.roomId ? rooms.find((r) => r.id === agent.roomId) : undefined) ??
    rooms[0]
  );
}

/** Muebles agrupados: «Escritorio ×2 · Silla ×2 · Planta». */
export function furnitureSummary(furniture: FurnitureItem[]): string {
  const counts = new Map<string, number>();
  for (const f of furniture) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${FURNITURE[k]?.label ?? k}${n > 1 ? ` ×${n}` : ""}`).join(" · ");
}

/** Busca una sala por id o nombre (exacto y, si no, parcial; sin distinguir mayúsculas). */
export function findRoomByRef(rooms: Room[], ref: string): Room | undefined {
  const n = ref.trim().toLowerCase();
  if (!n) return undefined;
  return rooms.find((r) => r.id === ref || r.name.toLowerCase() === n) ?? rooms.find((r) => r.name.toLowerCase().includes(n));
}

/**
 * Elige asiento libre en una sala: para dormir, cama o junto a un escritorio;
 * para trabajar, junto a un escritorio o cualquier asiento que no sea cama.
 * Si el agente tiene escritorio asignado (`own`), va a su silla; las sillas
 * asignadas a otros (`reserved`) solo se usan si no queda otra.
 */
export function pickSeat<S extends { id?: string; roomId: string; bed: boolean; nearDesk: boolean }>(
  seats: S[],
  roomId: string | undefined,
  taken: (s: S) => boolean,
  wantBed: boolean,
  opts: { own?: string | null; reserved?: (s: S) => boolean } = {},
): S | undefined {
  const free = seats.filter((s) => s.roomId === roomId && !taken(s));
  const mine = opts.own ? free.find((s) => s.id === opts.own) : undefined;
  const choose = (list: S[]) =>
    wantBed
      ? (list.find((s) => s.bed) ?? (mine && list.includes(mine) ? mine : undefined) ?? list.find((s) => s.nearDesk) ?? list[0])
      : ((mine && list.includes(mine) ? mine : undefined) ?? list.find((s) => s.nearDesk) ?? list.find((s) => !s.bed) ?? list[0]);
  const reserved = opts.reserved;
  const open = reserved ? free.filter((s) => s === mine || !reserved(s)) : free;
  return choose(open) ?? choose(free);
}

/** Etiqueta de dueño de una sala: «de Gwen» o «común». */
export function roomOwnerLabel(room: Room, agents: Pick<Agent, "id" | "name">[]): string {
  const owner = room.agentId ? agents.find((a) => a.id === room.agentId) : undefined;
  return owner ? `de ${owner.name}` : "común";
}

/**
 * Relación de un agente con una sala, para etiquetas: «la tuya» si es su sala
 * propia, «tu escritorio» si es la sala común donde lo tiene, o null.
 */
export function roomRelation(room: Pick<Room, "id" | "agentId">, agent: Pick<Agent, "id" | "roomId">): "propia" | "escritorio" | null {
  if (room.agentId && room.agentId === agent.id) return "propia";
  if (room.id === agent.roomId) return room.agentId ? "propia" : "escritorio";
  return null;
}
