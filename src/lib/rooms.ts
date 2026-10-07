import { randomUUID } from "node:crypto";
import { archiveRoom, createRoom, deleteRoom, getRoom, listRooms, unarchiveRoom, updateRoom } from "./repo/rooms";
import { getAgent, listAgents, setAgentLocation, updateAgent } from "./repo/agents";
import { tx } from "./db";
import { applyTemplateTints, BUILDINGS, buildingLevel, DESK_ROOMS, floorLabel, pickRoomTemplate, ROOM_TEMPLATES, type RoomTemplate } from "./roomTemplates";
import { decorate, DESK_SETS as DESK_SETS_KINDS, removeKinds, type DecorResult } from "../living/decorator";
import { buildingOf, DEFAULT_BUILDING, ELEVATOR_KIND, levelOf, levelOrigin, levelsOf, nextRoomPosition, ROOM_SIZE, roomFits, roomsConnected } from "../living/house";
import { checkRoomRemoval, joinNames } from "../living/roomRemoval";
import { assertLayout, moveItem, placeNew, removeItem, roomContext as contextFor, topsOf } from "../living/roomEditor";
import { coherenceWarnings, explainRejection, findItemRef, itemName, nearestValid, shortIds, spotsNear, type Spot } from "../living/roomMap";
import { FURNITURE } from "../living/furniture";
import { currentRoom, deskSeats, freeDeskSeat, furnitureSummary, roomOwnerLabel, roomRelation } from "../living/presence";
import { applyFinish, describeFinishes, findFloorFinish, findWallFinish, FLOOR_FINISHES, WALL_FINISHES, type FloorFinish, type WallFinish } from "../living/finishes";
import type { Agent, FurnitureItem, Room, RoomStyle } from "./types";

/**
 * Lista de salas para el contexto de un agente: todas, con su dueño de
 * referencia, quién está dentro y sus muebles. Marca dónde está él. Con
 * varias plantas, se agrupan por planta (de arriba abajo, como un directorio).
 */
export function describeRooms(rooms: Room[], agents: Agent[], me: Pick<Agent, "id" | "roomId" | "locationRoomId">): string {
  if (!rooms.length) return "Salas de la casa: ninguna todavía.";
  const here = currentRoom(me, rooms);
  const relation = { propia: ", la tuya", escritorio: ", aquí tienes tu escritorio", ninguna: "" };
  const line = (r: Room) => {
    const inside = agents.filter((a) => a.id !== me.id && currentRoom(a, rooms)?.id === r.id).map((a) => a.name);
    return [
      `- ${r.name} (${roomOwnerLabel(r, agents)}${relation[roomRelation(r, me) ?? "ninguna"]})`,
      r.id === here?.id ? " ← estás aquí" : "",
      inside.length ? ` · aquí: ${inside.join(", ")}` : "",
      ` · ${r.w}×${r.d} · muebles: ${furnitureSummary(r.furniture) || "ninguno"}`,
    ].join("");
  };
  const levels = levelsOf(rooms);
  const head = "Salas de la casa (todas se pueden usar y decorar):";
  if (levels.length < 2) return `${head}\n${rooms.map(line).join("\n")}`;
  // Torre con varias plantas, unidas por el núcleo de ascensores.
  const groups = [...levels].reverse().map((level) => {
    const mine = rooms.filter((r) => levelOf(r) === level);
    const zones = [...new Set(mine.map(buildingOf))].map((b) => `edificio=«${b}»`).join(", ");
    return `${floorLabel(level)} (${zones}):\n${mine.map(line).join("\n")}`;
  });
  return `${head}\nTorre de oficinas: se cambia de planta en ascensor.\n${groups.join("\n")}`;
}

/** Salas de una planta. */
const onLevel = (rooms: Room[], level: number) => rooms.filter((r) => levelOf(r) === level);

/**
 * Crea una sala nueva para un ámbito (con o sin agente) en el siguiente
 * hueco de su edificio y la amuebla con el decorador automático (o con la
 * distribución fija de la plantilla si se pide `fixed`). Sin edificio, va a
 * la casa de Orden.
 */
export function buildRoom(input: {
  name?: string;
  domain: string;
  agentId?: string | null;
  id?: string;
  template?: RoomTemplate;
  building?: string;
  fixed?: boolean;
  /** Sin muebles (sala en blanco para decorar a mano). */
  empty?: boolean;
}): Room {
  const building = input.building ?? input.template?.building ?? DEFAULT_BUILDING;
  const tpl = input.template && (input.template.building ?? DEFAULT_BUILDING) === building ? input.template : pickRoomTemplate(input.domain, building);
  const rooms = listRooms();
  // Cada zona tiene su planta: la sala crece desde la esquina de esa planta (con las de su planta).
  const level = buildingLevel(building);
  const pos = nextRoomPosition(onLevel(rooms, level), building, { origin: levelOrigin(level) });
  const id = input.id ?? randomUUID();
  const draft: Room = {
    id,
    name: input.name ?? tpl.label,
    kind: tpl.kind,
    agentId: input.agentId ?? null,
    building,
    level,
    x: pos.x,
    y: pos.y,
    w: ROOM_SIZE,
    d: ROOM_SIZE,
    style: tpl.style,
    furniture: [],
    createdAt: "",
    updatedAt: "",
  };
  if (input.empty) {
    const blank = createRoom(draft);
    ensureElevators();
    return blank;
  }
  const fixed = (input.fixed || !tpl.kinds) && tpl.furniture;
  const furniture = fixed
    ? fixed.map((f) => ({ ...f, id: randomUUID() }))
    : decorate([], tpl.kinds ?? [], contextFor(draft, [...rooms, draft])).furniture;
  const room = createRoom({ ...draft, furniture: applyTemplateTints(furniture, tpl) });
  ensureElevators();
  return room;
}

/**
 * Núcleo de ascensores: con más de una planta, cada planta necesita un
 * ascensor para llegar a ella. A la que no lo tenga se le pone uno (en la
 * primera sala donde quepa).
 */
export function ensureElevators() {
  const rooms = listRooms();
  const levels = levelsOf(rooms);
  if (levels.length < 2) return;
  for (const level of levels) {
    const mine = onLevel(rooms, level);
    if (mine.some((r) => r.furniture.some((f) => f.kind === ELEVATOR_KIND))) continue;
    for (const r of mine) if (redecorateRoom(r.id, { add: [ELEVATOR_KIND] }).placed.length) break;
  }
}

/** Nombre libre a partir de una base: «Sala nueva», «Sala nueva 2»… (sin distinguir mayúsculas). */
export function uniqueRoomName(base: string, rooms: Pick<Room, "name">[]): string {
  const taken = new Set(rooms.map((r) => r.name.trim().toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

export const BLANK_ROOM_NAME = "Sala nueva";

/**
 * Sala vacía creada a mano desde el editor de sala: común (sin dueño), sin
 * muebles y en el siguiente hueco de su edificio. Usa la plantilla genérica
 * del edificio (el estudio de la casa), así que lleva su suelo y sus paredes
 * y, al decorarla, los muebles toman sus colores.
 */
export function createBlankRoom(input: { building?: string; name?: string } = {}): Room {
  const building = input.building && BUILDINGS[input.building] ? input.building : DEFAULT_BUILDING;
  const template = ROOM_TEMPLATES[BUILDINGS[building].fallback];
  const name = input.name?.trim() || uniqueRoomName(BLANK_ROOM_NAME, listRooms());
  return buildRoom({ name, domain: template.label, template, building, empty: true });
}

/**
 * Asigna un escritorio a un agente nuevo (no se le crea sala propia): busca
 * una silla de puesto libre en una sala común de la casa (la oficina
 * compartida). Si no hay hueco añade un puesto con el decorador, sin mover lo
 * que ya hay; si no cabe o no hay ninguna sala así, abre una oficina
 * compartida nueva.
 */
export function assignDesk(specialty: string, agents: Pick<Agent, "deskSeatId">[]): { room: Room; seatId: string } {
  const building = DEFAULT_BUILDING;
  const cfg = DESK_ROOMS[building];
  const preferred = pickRoomTemplate(specialty, building).kind;
  const rank = (r: Room) => (r.kind === preferred ? -1 : cfg.kinds.indexOf(r.kind));
  const candidates = listRooms()
    .filter((r) => !r.agentId && buildingOf(r) === building && cfg.kinds.includes(r.kind))
    .sort((a, b) => rank(a) - rank(b));
  for (const room of candidates) {
    const seat = freeDeskSeat(room, agents);
    if (seat) return { room, seatId: seat.id };
  }
  for (const room of candidates) {
    const before = new Set(room.furniture.map((f) => f.id));
    const { room: updated, placed } = redecorateRoom(room.id, { add: [cfg.desk] });
    if (!placed.length) continue;
    const seat = deskSeats(updated.furniture).find((f) => !before.has(f.id));
    if (seat) return { room: updated, seatId: seat.id };
  }
  const tpl = ROOM_TEMPLATES[cfg.office];
  const room = buildRoom({ name: uniqueRoomName(tpl.label, listRooms()), domain: tpl.label, template: tpl, building });
  const seat = freeDeskSeat(room, agents);
  if (!seat) throw new Error("No hay sitio para un escritorio nuevo.");
  return { room, seatId: seat.id };
}

/**
 * Añade y/o quita muebles de una sala existente. `remove` admite tipos
 * («planta», quita uno) o ids de mueble completos o cortos (quita ese, con lo
 * que tenga encima).
 */
export function redecorateRoom(roomId: string, opts: { add?: string[]; remove?: string[]; style?: Partial<RoomStyle> }): { room: Room } & Pick<DecorResult, "placed" | "skipped"> & { removed: string[] } {
  const room = getRoom(roomId);
  if (!room) throw new Error("No existe esa sala.");
  let current = room.furniture;
  const byId: string[] = [];
  const kinds: string[] = [];
  for (const ref of opts.remove ?? []) {
    const hit = FURNITURE[ref] ? undefined : findItemRef(current, ref).item;
    if (hit) {
      current = removeItem(current, hit.id);
      byId.push(itemName(hit));
    } else kinds.push(ref);
  }
  const { furniture: afterRemove, removed: removedKinds } = removeKinds(current, kinds);
  const removed = [...byId, ...removedKinds];
  const result = opts.add?.length ? decorate(afterRemove, opts.add, contextFor(room, listRooms())) : { furniture: afterRemove, placed: [], skipped: [] };
  // Lo nuevo toma los colores de la sala (si su plantilla los define); lo que ya había no se toca.
  const before = new Set(afterRemove.map((f) => f.id));
  const tpl = ROOM_TEMPLATES[room.kind];
  const furniture = result.furniture.map((f) => (before.has(f.id) ? f : applyTemplateTints([f], tpl)[0]));
  const updated = updateRoom(roomId, { furniture, ...(opts.style && { style: { ...room.style, ...opts.style } }) });
  return { room: updated, placed: result.placed, skipped: result.skipped, removed };
}

/** Posición pedida por un agente: coordenadas (y giro) o «junto a» otro mueble. */
export interface PlaceRequest {
  x?: number;
  y?: number;
  /** true = girado (en adornos de pared: muro oeste). Sin indicar: el actual o el que pida la posición. */
  flip?: boolean;
  /** Id (completo o corto) del mueble junto al que ponerlo. */
  near?: string;
}

/** Resultado de colocar o mover: la sala, los muebles tocados y avisos de coherencia (no bloquean). */
export interface PlaceResult {
  room: Room;
  items: FurnitureItem[];
  warnings: string[];
}

/** En adornos de pared el giro se deduce de la posición: y=0 → muro norte; x=0 → muro oeste. */
function wallFlip(kind: string, x: number, y: number, flip: boolean | undefined, fallback: boolean): boolean {
  if (flip !== undefined || !FURNITURE[kind]?.wall) return flip ?? fallback;
  if (y === 0 && x > 0) return false;
  if (x === 0 && y > 0) return true;
  return fallback;
}

function finishPlacement(room: Room, furniture: FurnitureItem[], touched: string[]): PlaceResult {
  const updated = updateRoom(room.id, { furniture });
  const ctx = contextFor(updated, listRooms());
  const ids = shortIds(updated.furniture);
  const name = (it: FurnitureItem) => itemName(it, ids);
  return {
    room: updated,
    items: touched.map((id) => updated.furniture.find((f) => f.id === id)!).filter(Boolean),
    warnings: coherenceWarnings(updated.furniture, ctx, name),
  };
}

function sugerencias(cands: [number, number][]): string {
  return cands.length ? ` Posiciones válidas cercanas: ${cands.map(([x, y]) => `(${x},${y})`).join(", ")}.` : " No queda ningún hueco válido.";
}

/**
 * Añade un mueble del catálogo en una posición elegida (x, y y giro) o junto
 * a otro mueble. «puesto»: la silla en (x, y) y el escritorio
 * delante (a su derecha o, girado, debajo). Lanza un error claro (con quién
 * choca y huecos válidos cercanos) si no cabe; entonces no cambia nada.
 */
export function placeFurnitureAt(roomId: string, kind: string, req: PlaceRequest): PlaceResult {
  const room = getRoom(roomId);
  if (!room) throw new Error("No existe esa sala.");
  const ctx = contextFor(room, listRooms());
  const tpl = ROOM_TEMPLATES[room.kind];
  const tintOf = (k: string) => applyTemplateTints<{ kind: string; tint?: Record<string, string> }>([{ kind: k }], tpl)[0].tint;
  const ids = shortIds(room.furniture);
  const items = room.furniture;

  if (DESK_SETS_KINDS[kind]) {
    if (req.x === undefined || req.y === undefined) throw new Error(`Para «${kind}» indica x e y (posición de la silla).`);
    const [chair, desk] = DESK_SETS_KINDS[kind];
    const flip = Boolean(req.flip);
    const a = placeNew(items, chair, req.x, req.y, flip, ctx, tintOf(chair));
    if (a.error) throw new Error(`La silla no cabe en (${req.x},${req.y}): ${explainRejection(items, { id: "?", kind: chair, x: req.x, y: req.y, ...(flip && { flip }) }, ctx, ids)}`);
    const [dx, dy] = flip ? [req.x, req.y + 1] : [req.x + 1, req.y];
    const b = placeNew(a.furniture, desk, dx, dy, !flip, ctx, tintOf(desk));
    if (b.error) throw new Error(`El escritorio no cabe en (${dx},${dy}): ${explainRejection(a.furniture, { id: "?", kind: desk, x: dx, y: dy, ...(!flip && { flip: true }) }, ctx, ids)}`);
    return finishPlacement(room, b.furniture, [a.id!, b.id!]);
  }
  if (!FURNITURE[kind]) throw new Error(`No conozco el mueble «${kind}».`);

  if (req.near) {
    const { item: target, error } = findItemRef(items, req.near);
    if (!target) throw new Error(error);
    for (const s of spotsNear(kind, target, ctx)) {
      const r = placeNew(items, kind, s.x, s.y, s.flip, ctx, tintOf(kind));
      if (!r.error) return finishPlacement(room, r.furniture, [r.id!]);
    }
    throw new Error(`No hay hueco para ${FURNITURE[kind].label.toLowerCase()} junto a ${itemName(target, ids)}.`);
  }
  if (req.x === undefined || req.y === undefined) throw new Error("Indica x e y, o junto_a.");
  const flip = wallFlip(kind, req.x, req.y, req.flip, false);
  const r = placeNew(items, kind, req.x, req.y, flip, ctx, tintOf(kind));
  if (r.error) {
    const probe = { id: "?", kind, x: req.x, y: req.y, ...(flip && { flip }) };
    throw new Error(`No cabe en (${req.x},${req.y}): ${explainRejection(items, probe, ctx, ids)}${sugerencias(nearestValid(items, { id: "?", kind, ...(flip && { flip }) }, req.x, req.y, ctx))}`);
  }
  return finishPlacement(room, r.furniture, [r.id!]);
}

/**
 * Mueve y/o gira un mueble concreto (por id completo o corto) a una posición o
 * junto a otro mueble. Lo que lleva encima viaja con él. Si no cabe, lanza un
 * error claro y no cambia nada.
 */
export function moveFurniture(roomId: string, ref: string, req: PlaceRequest): PlaceResult {
  const room = getRoom(roomId);
  if (!room) throw new Error("No existe esa sala.");
  const items = room.furniture;
  const { item: cur, error } = findItemRef(items, ref);
  if (!cur) throw new Error(error);
  const ctx = contextFor(room, listRooms());
  const ids = shortIds(items);
  const moving = new Set([cur.id, ...topsOf(items, cur).map((it) => it.id)]);
  const others = items.filter((it) => !moving.has(it.id));

  if (req.near) {
    const { item: target, error: e } = findItemRef(items, req.near);
    if (!target) throw new Error(e);
    if (moving.has(target.id)) throw new Error("No se puede poner un mueble junto a sí mismo.");
    const spots: Spot[] = spotsNear(cur.kind, target, ctx);
    for (const s of spots) {
      const r = moveItem(items, cur.id, s.x, s.y, ctx, s.flip);
      if (!r.error) return finishPlacement(room, r.furniture, [cur.id]);
    }
    throw new Error(`No hay hueco para ${itemName(cur, ids)} junto a ${itemName(target, ids)}.`);
  }
  if (req.x === undefined && req.y === undefined && req.flip === undefined) throw new Error("Indica x, y, girado o junto_a.");
  const x = req.x ?? cur.x;
  const y = req.y ?? cur.y;
  // En la pared, girar sin moverse es pasar al otro muro en la misma posición a lo largo.
  const isWall = Boolean(FURNITURE[cur.kind]?.wall);
  let [tx, ty] = [x, y];
  const flip = wallFlip(cur.kind, x, y, req.flip, Boolean(cur.flip));
  if (isWall && req.x === undefined && req.y === undefined && flip !== Boolean(cur.flip)) {
    const along = cur.flip ? cur.y : cur.x;
    [tx, ty] = flip ? [0, along] : [along, 0];
  }
  const r = moveItem(items, cur.id, tx, ty, ctx, flip);
  if (r.error) {
    const { flip: _f, ...base } = cur;
    const probe = { ...base, x: tx, y: ty, ...(flip && { flip }) };
    throw new Error(
      `No se puede mover ${itemName(cur, ids)} a (${tx},${ty})${flip !== Boolean(cur.flip) ? " girado" : ""}: ${explainRejection(others, probe, ctx, ids)}${sugerencias(nearestValid(others, { ...base, ...(flip && { flip }) }, tx, ty, ctx))}`,
    );
  }
  return finishPlacement(room, r.furniture, [cur.id]);
}

/**
 * Guarda la distribución hecha a mano en el editor de sala. Sustituye todos
 * los muebles de golpe (el editor trabaja sobre una copia de la sala).
 */
export function setRoomLayout(roomId: string, furniture: FurnitureItem[]): Room {
  const room = getRoom(roomId);
  if (!room) throw new Error("No existe esa sala.");
  assertLayout(furniture, room);
  const clean = furniture.map(({ id, kind, x, y, z, flip, tint, manual }) => ({
    id,
    kind,
    x,
    y,
    ...(z !== undefined && { z }),
    ...(flip && { flip: true }),
    ...(tint && { tint }),
    ...(manual && { manual: true }),
  }));
  return updateRoom(roomId, { furniture: clean });
}

/**
 * Borra una sala desde el editor: va a la papelera (recuperable). Respeta
 * `checkRoomRemoval`: no borra la última de un edificio, la sala propia de un
 * agente ni una que deje salas sin paso. A quien tenga aquí su escritorio se le
 * asigna otro puesto libre (como al contratar), pero solo con `relocate`.
 */
export function removeRoom(roomId: string, opts: { relocate?: boolean } = {}): { room: Room; relocated: { agent: string; room: string }[] } {
  return tx(() => {
    const room = getRoom(roomId);
    if (!room) throw new Error("No existe esa sala (quizá ya está en la papelera).");
    const check = checkRoomRemoval(room, listRooms(), listAgents());
    if (check.blocked) throw new Error(check.blocked);
    const names = joinNames(check.relocate.map((a) => a.name));
    if (check.relocate.length && !opts.relocate) {
      throw new Error(`Aquí tiene${check.relocate.length > 1 ? "n" : ""} su escritorio ${names}: confirma que se le${check.relocate.length > 1 ? "s" : ""} asigne otro puesto.`);
    }
    // Primero se archiva (así el puesto nuevo nunca cae en esta sala).
    const archived = archiveRoom(room.id);
    const relocated = check.relocate.map(({ id }) => {
      const agent = getAgent(id)!;
      const desk = assignDesk(agent.specialty, listAgents());
      updateAgent(id, { roomId: desk.room.id, deskSeatId: desk.seatId });
      return { agent: agent.name, room: desk.room.name };
    });
    return { room: archived, relocated };
  });
}

/**
 * Convierte una sala en el despacho propio de un agente: pasa a ser su dueño,
 * se le asigna una silla de puesto libre de la sala y vuelve a ella. Si tenía
 * otra sala propia, esa queda común. Su escritorio anterior queda libre.
 */
export function assignOwnRoom(roomId: string, agentId: string): { room: Room; agent: Agent } {
  return tx(() => {
    const room = getRoom(roomId);
    if (!room) throw new Error("No existe esa sala.");
    const agent = getAgent(agentId);
    if (!agent) throw new Error("No existe ese agente.");
    if (room.agentId && room.agentId !== agent.id) {
      const owner = getAgent(room.agentId);
      throw new Error(`«${room.name}» ya es el despacho de ${owner?.name ?? "otro agente"}.`);
    }
    const others = listAgents().filter((a) => a.id !== agent.id);
    const seat = freeDeskSeat(room, others);
    if (!seat) throw new Error(`«${room.name}» no tiene ningún puesto libre (silla junto a un escritorio): añade uno antes.`);
    for (const r of listRooms()) if (r.agentId === agent.id && r.id !== room.id) updateRoom(r.id, { agentId: null });
    const updated = updateRoom(room.id, { agentId: agent.id });
    updateAgent(agent.id, { roomId: room.id, deskSeatId: seat.id });
    setAgentLocation(agent.id, null);
    return { room: updated, agent: getAgent(agent.id)! };
  });
}

/**
 * Saca una sala de la papelera. Vuelve a su sitio si sigue libre y comunicado
 * con el resto de su edificio; si no, al siguiente hueco libre. Vuelve vacía de
 * agentes (sus antiguos escritorios ya se reasignaron).
 */
export function restoreRoom(roomId: string): Room {
  return tx(() => {
    const room = getRoom(roomId, { archived: true });
    if (!room?.archivedAt) throw new Error("Esa sala no está en la papelera.");
    const rooms = listRooms();
    const siblings = rooms.filter((r) => buildingOf(r) === buildingOf(room));
    const fits = roomFits(rooms, room) && (!siblings.length || roomsConnected([...siblings, room]));
    const level = levelOf(room);
    const pos = fits ? { x: room.x, y: room.y } : nextRoomPosition(onLevel(rooms, level), buildingOf(room), { origin: levelOrigin(level) });
    return unarchiveRoom(room.id, pos);
  });
}

/** Borra para siempre una sala que ya está en la papelera. */
export function purgeRoom(roomId: string): Room {
  const room = getRoom(roomId, { archived: true });
  if (!room?.archivedAt) throw new Error("Solo se pueden borrar del todo las salas de la papelera.");
  deleteRoom(room.id);
  return room;
}

/**
 * Cambia el suelo y/o las paredes de una sala por acabados del catálogo
 * (`living/finishes.ts`), por id o por nombre. Lo que no se indica no cambia.
 */
export function setRoomFinish(roomId: string, pick: { suelo?: string; pared?: string }): { room: Room; floor: FloorFinish | null; wall: WallFinish | null } {
  const room = getRoom(roomId);
  if (!room) throw new Error("No existe esa sala.");
  const floor = pick.suelo?.trim() ? (findFloorFinish(pick.suelo) ?? null) : null;
  const wall = pick.pared?.trim() ? (findWallFinish(pick.pared) ?? null) : null;
  if (pick.suelo?.trim() && !floor) throw new Error(`No conozco el suelo «${pick.suelo}». Suelos: ${describeFinishes(FLOOR_FINISHES)}.`);
  if (pick.pared?.trim() && !wall) throw new Error(`No conozco la pared «${pick.pared}». Paredes: ${describeFinishes(WALL_FINISHES)}.`);
  if (!floor && !wall) throw new Error("Indica un suelo, una pared o los dos.");
  return { room: updateRoom(roomId, { style: applyFinish(room.style, { floor, wall }) }), floor, wall };
}

/** Vacía y vuelve a amueblar una sala según su plantilla. */
export function refurnishRoom(roomId: string): Room {
  const room = getRoom(roomId);
  if (!room) throw new Error("No existe esa sala.");
  const tpl = ROOM_TEMPLATES[room.kind];
  if (!tpl?.kinds) throw new Error("Esta sala está decorada a mano y no se puede reamueblar.");
  const furniture = decorate([], tpl.kinds, { ...contextFor(room, listRooms()), seed: room.id + Date.now() }).furniture;
  return updateRoom(roomId, { furniture: applyTemplateTints(furniture, tpl) });
}
