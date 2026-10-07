import { randomUUID } from "node:crypto";
import { getDb, now, parseJson } from "../db";
import { emit } from "../events";
import { setAgentLocation } from "./agents";
import type { FurnitureItem, Room, RoomStyle } from "../types";

interface RoomRow {
  id: string;
  name: string;
  kind: string;
  agent_id: string | null;
  building: string | null;
  level: number | null;
  x: number;
  y: number;
  w: number;
  d: number;
  style: string;
  furniture: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_STYLE: RoomStyle = {
  floor: "madera",
  floorA: "#b98a5a",
  floorB: "#a87b4e",
  wall: "#d9d2c3",
  wallTrim: "#8a7f6e",
};

function toRoom(r: RoomRow): Room {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    agentId: r.agent_id,
    building: r.building || "orden",
    level: r.level ?? 0,
    x: r.x,
    y: r.y,
    w: r.w,
    d: r.d,
    style: { ...DEFAULT_STYLE, ...parseJson<Partial<RoomStyle>>(r.style, {}) },
    furniture: parseJson<FurnitureItem[]>(r.furniture, []),
    ...(r.archived_at && { archivedAt: r.archived_at }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Salas en uso (o, con `archived`, las de la papelera; las más recientes primero). */
export function listRooms(opts: { archived?: boolean } = {}): Room[] {
  const sql = opts.archived
    ? "SELECT * FROM rooms WHERE archived_at IS NOT NULL ORDER BY archived_at DESC"
    : "SELECT * FROM rooms WHERE archived_at IS NULL ORDER BY created_at";
  return (getDb().prepare(sql).all() as unknown as RoomRow[]).map(toRoom);
}

/** Sala en uso (las de la papelera no cuentan salvo con `archived`). */
export function getRoom(id: string, opts: { archived?: boolean } = {}): Room | null {
  const row = getDb().prepare("SELECT * FROM rooms WHERE id = ?").get(id) as unknown as RoomRow | undefined;
  if (!row || (row.archived_at && !opts.archived)) return null;
  return toRoom(row);
}

export interface NewRoom {
  id?: string;
  name: string;
  kind: string;
  agentId?: string | null;
  /** Edificio (por defecto, la casa de Orden). */
  building?: string;
  /** Planta de la torre (x ya incluye su franja del plano). */
  level?: number;
  x: number;
  y: number;
  w: number;
  d: number;
  style?: Partial<RoomStyle>;
  furniture?: FurnitureItem[];
}

export function createRoom(input: NewRoom): Room {
  const id = input.id ?? randomUUID();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO rooms (id, name, kind, agent_id, building, level, x, y, w, d, style, furniture, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.kind,
      input.agentId ?? null,
      input.building ?? "orden",
      input.level ?? 0,
      input.x,
      input.y,
      input.w,
      input.d,
      JSON.stringify({ ...DEFAULT_STYLE, ...input.style }),
      JSON.stringify(input.furniture ?? []),
      ts,
      ts,
    );
  const room = getRoom(id)!;
  emit("room.created", room);
  return room;
}

export type RoomPatch = Partial<Pick<Room, "name" | "kind" | "agentId" | "style" | "furniture">>;

export function updateRoom(id: string, patch: RoomPatch): Room {
  const current = getRoom(id);
  if (!current) throw new Error(`No existe la sala ${id}`);
  const next = { ...current, ...patch };
  getDb()
    .prepare("UPDATE rooms SET name = ?, kind = ?, agent_id = ?, style = ?, furniture = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.kind, next.agentId, JSON.stringify(next.style), JSON.stringify(next.furniture), now(), id);
  const room = getRoom(id)!;
  emit("room.updated", room);
  return room;
}

/** Quien estuviera de visita en esa sala vuelve a la suya. */
function sendVisitorsHome(id: string) {
  const visitors = getDb().prepare("SELECT id FROM agents WHERE location_room_id = ?").all(id) as unknown as { id: string }[];
  for (const v of visitors) setAgentLocation(v.id, null);
}

/** Manda una sala a la papelera: desaparece de la casa pero se puede recuperar. */
export function archiveRoom(id: string): Room {
  sendVisitorsHome(id);
  getDb().prepare("UPDATE rooms SET archived_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  emit("room.deleted", { id });
  return getRoom(id, { archived: true })!;
}

/** Saca una sala de la papelera, en la posición indicada (la suya o un hueco nuevo). */
export function unarchiveRoom(id: string, pos: { x: number; y: number }): Room {
  getDb().prepare("UPDATE rooms SET archived_at = NULL, x = ?, y = ?, updated_at = ? WHERE id = ?").run(pos.x, pos.y, now(), id);
  const room = getRoom(id)!;
  emit("room.created", room);
  return room;
}

/** Borra una sala para siempre. */
export function deleteRoom(id: string) {
  sendVisitorsHome(id);
  getDb().prepare("DELETE FROM rooms WHERE id = ?").run(id);
  emit("room.deleted", { id });
}
