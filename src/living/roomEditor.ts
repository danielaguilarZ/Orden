/**
 * Edición manual de una sala: colocar, mover, girar y quitar muebles a mano.
 *
 * Lógica pura (sin React ni Pixi) para poder testearla. Reglas:
 * - los muebles de suelo no se salen de la sala, no se solapan entre sí y no
 *   tapan las puertas; las alfombras solo no se solapan con otras alfombras;
 * - los adornos de pared van en el muro norte (y = 0) o, girados, en el
 *   oeste (x = 0), solo donde hay muro alto y sin solaparse;
 * - los objetos pequeños van encima de una superficie (escritorio, mesa…);
 * - al mover o girar una superficie, lo que tiene encima viaja con ella.
 *
 * Todo lo que se toca a mano queda marcado con `manual: true`.
 */

import { decorate, DESK_SETS, doorTiles, type DecorContext } from "./decorator";
import { FURNITURE, footprint } from "./furniture";
import { outerWallSides } from "./houseRender";
import type { FurnitureItem, Room } from "../lib/types";

export interface EditContext {
  w: number;
  d: number;
  northWall: boolean[];
  westWall: boolean[];
}

/** Contexto de edición (y del decorador) de una sala ya situada en la casa. */
export function roomContext(room: Room, rooms: Room[]): DecorContext {
  const sides = outerWallSides(room, rooms);
  return { w: room.w, d: room.d, northWall: sides.north, westWall: sides.west, seed: room.id };
}

export interface EditResult {
  furniture: FurnitureItem[];
  /** Motivo por el que no se ha podido hacer (la lista queda igual). */
  error?: string;
  /** Id del mueble afectado. */
  id?: string;
}

let counter = 0;
export const newFurnitureId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const isFloor = (kind: string) => {
  const def = FURNITURE[kind];
  return Boolean(def && !def.wall && !def.onTop);
};

/** Baldosas de suelo que ocupa un mueble (vacío para adornos de pared y objetos encima). */
export function cellsOf(it: FurnitureItem): [number, number][] {
  if (!isFloor(it.kind)) return [];
  const fp = footprint(it.kind, it.flip);
  const out: [number, number][] = [];
  for (let dy = 0; dy < fp.d; dy++) for (let dx = 0; dx < fp.w; dx++) out.push([it.x + dx, it.y + dy]);
  return out;
}

/** Tramo de muro que ocupa un adorno de pared. */
export function wallSpan(it: FurnitureItem): { side: "n" | "w"; from: number; to: number } {
  const span = FURNITURE[it.kind]?.w ?? 1;
  return it.flip ? { side: "w", from: it.y, to: it.y + span } : { side: "n", from: it.x, to: it.x + span };
}

/** Superficie (escritorio, mesa…) que cubre una baldosa, si la hay. */
export function surfaceAt(items: FurnitureItem[], x: number, y: number): { item: FurnitureItem; z: number } | null {
  for (const it of items) {
    const def = FURNITURE[it.kind];
    if (!def?.surface || def.onTop || def.wall) continue;
    if (cellsOf(it).some(([cx, cy]) => cx === x && cy === y)) return { item: it, z: def.surface };
  }
  return null;
}

/** Objetos pequeños que hay encima de una superficie. */
export function topsOf(items: FurnitureItem[], surface: FurnitureItem): FurnitureItem[] {
  const cells = new Set(cellsOf(surface).map(([x, y]) => `${x},${y}`));
  if (!FURNITURE[surface.kind]?.surface || !cells.size) return [];
  return items.filter((it) => it.id !== surface.id && FURNITURE[it.kind]?.onTop && cells.has(`${it.x},${it.y}`));
}

/**
 * ¿Cabe `item` tal cual entre `others`? Devuelve el motivo si no.
 * `others` no debe incluir al propio mueble (ni a lo que lleva encima).
 */
export function checkItem(others: FurnitureItem[], item: FurnitureItem, ctx: EditContext): string | null {
  const def = FURNITURE[item.kind];
  if (!def) return `No conozco el mueble «${item.kind}».`;
  if (!Number.isInteger(item.x) || !Number.isInteger(item.y)) return "Posición no válida.";

  if (def.wall) {
    const { side, from, to } = wallSpan(item);
    if (side === "n" ? item.y !== 0 : item.x !== 0) return "Los adornos de pared van en el muro del fondo.";
    const avail = side === "n" ? ctx.northWall : ctx.westWall;
    if (from < 0 || to > avail.length) return "No cabe en esa pared.";
    for (let i = from; i < to; i++) if (!avail[i]) return "Ahí no hay muro donde colgarlo.";
    for (const o of others) {
      if (!FURNITURE[o.kind]?.wall) continue;
      const s = wallSpan(o);
      if (s.side === side && s.from < to && from < s.to) return `Choca con ${FURNITURE[o.kind].label.toLowerCase()}.`;
    }
    return null;
  }

  if (item.x < 0 || item.y < 0 || item.x >= ctx.w || item.y >= ctx.d) return "Se sale de la sala.";

  if (def.onTop) {
    if (!surfaceAt(others, item.x, item.y)) return "Va encima de un escritorio o una mesa.";
    const busy = others.find((o) => FURNITURE[o.kind]?.onTop && o.x === item.x && o.y === item.y);
    if (busy) return `Ahí ya está ${FURNITURE[busy.kind].label.toLowerCase()}.`;
    return null;
  }

  const fp = footprint(item.kind, item.flip);
  if (item.x + fp.w > ctx.w || item.y + fp.d > ctx.d) return "Se sale de la sala.";
  const mine = cellsOf(item);
  const doors = new Set(doorTiles(ctx.w, ctx.d).map(([x, y]) => `${x},${y}`));
  if (!def.walkable && mine.some(([x, y]) => doors.has(`${x},${y}`))) return "Taparía una puerta.";
  const keys = new Set(mine.map(([x, y]) => `${x},${y}`));
  for (const o of others) {
    const od = FURNITURE[o.kind];
    if (!od || !isFloor(o.kind)) continue;
    // Las alfombras solo chocan con otras alfombras; el resto, con lo que no se pisa.
    if (Boolean(def.walkable) !== Boolean(od.walkable)) continue;
    if (cellsOf(o).some(([x, y]) => keys.has(`${x},${y}`))) return `Choca con ${od.label.toLowerCase()}.`;
  }
  return null;
}

/** Coloca un objeto pequeño a la altura de la superficie que tenga debajo. */
function withZ(others: FurnitureItem[], item: FurnitureItem): FurnitureItem {
  if (!FURNITURE[item.kind]?.onTop) {
    const { z: _z, ...rest } = item;
    return rest;
  }
  const s = surfaceAt(others, item.x, item.y);
  return { ...item, z: s?.z ?? item.z };
}

/**
 * Traduce la casilla bajo el puntero al anclaje del mueble. La rejilla del
 * editor tiene una fila extra arriba (y = -1, muro norte) y una columna extra a
 * la izquierda (x = -1, muro oeste).
 */
export function dropTarget(kind: string, cx: number, cy: number, flip = false): { x: number; y: number; flip: boolean } | null {
  const def = FURNITURE[kind];
  if (!def) return null;
  if (def.wall) {
    if (cy === -1 && cx >= 0) return { x: cx, y: 0, flip: false };
    if (cx === -1 && cy >= 0) return { x: 0, y: cy, flip: true };
    if (cy === 0 && cx >= 0 && !(cx === 0 && flip)) return { x: cx, y: 0, flip: false };
    if (cx === 0 && cy >= 0) return { x: 0, y: cy, flip: true };
    return null;
  }
  if (cx < 0 || cy < 0) return null;
  return { x: cx, y: cy, flip };
}

/** Añade un mueble nuevo en una posición concreta. */
export function placeNew(items: FurnitureItem[], kind: string, x: number, y: number, flip: boolean, ctx: EditContext, tint?: Record<string, string>): EditResult {
  const item = withZ(items, { id: newFurnitureId(), kind, x, y, ...(flip && { flip: true }), ...(tint && { tint }), manual: true });
  const error = checkItem(items, item, ctx);
  if (error) return { furniture: items, error };
  return { furniture: [...items, item], id: item.id };
}

/** Mueve (y opcionalmente gira) un mueble; lo que tenga encima va con él. */
export function moveItem(items: FurnitureItem[], id: string, x: number, y: number, ctx: EditContext, flip?: boolean): EditResult {
  const cur = items.find((it) => it.id === id);
  if (!cur) return { furniture: items, error: "Ese mueble ya no está." };
  const nextFlip = flip ?? Boolean(cur.flip);
  const tops = topsOf(items, cur);
  const moving = new Set([id, ...tops.map((t) => t.id)]);
  const others = items.filter((it) => !moving.has(it.id));
  const { flip: _f, ...base } = cur;
  const moved = withZ(others, { ...base, x, y, ...(nextFlip && { flip: true }), manual: true });
  const error = checkItem(others, moved, ctx);
  if (error) return { furniture: items, error };
  const swap = nextFlip !== Boolean(cur.flip);
  const carried = tops.map((t) => {
    const rx = t.x - cur.x;
    const ry = t.y - cur.y;
    // Girar = espejar en la diagonal: las posiciones relativas intercambian ejes.
    return { ...t, x: x + (swap ? ry : rx), y: y + (swap ? rx : ry), manual: true };
  });
  const byId = new Map([moved, ...carried].map((it) => [it.id, it]));
  return { furniture: items.map((it) => byId.get(it.id) ?? it), id };
}

/** Gira un mueble (cambia de orientación o de pared) sin moverlo de sitio, si cabe. */
export function rotateItem(items: FurnitureItem[], id: string, ctx: EditContext): EditResult {
  const cur = items.find((it) => it.id === id);
  if (!cur) return { furniture: items, error: "Ese mueble ya no está." };
  if (FURNITURE[cur.kind]?.wall) {
    // En la pared, girar es pasar al otro muro en la misma posición a lo largo.
    const along = cur.flip ? cur.y : cur.x;
    return moveItem(items, id, cur.flip ? along : 0, cur.flip ? 0 : along, ctx, !cur.flip);
  }
  return moveItem(items, id, cur.x, cur.y, ctx, !cur.flip);
}

/** Quita un mueble (y lo que tenga encima, que si no quedaría flotando). */
export function removeItem(items: FurnitureItem[], id: string): FurnitureItem[] {
  const cur = items.find((it) => it.id === id);
  if (!cur) return items;
  const gone = new Set([id, ...topsOf(items, cur).map((t) => t.id)]);
  return items.filter((it) => !gone.has(it.id));
}

/** Avisos (no bloquean el guardado): zonas inaccesibles, asientos encerrados… */
export function layoutWarnings(items: FurnitureItem[], ctx: EditContext): string[] {
  const { w, d } = ctx;
  const blocked = new Array(w * d).fill(false);
  for (const it of items) {
    if (FURNITURE[it.kind]?.walkable) continue;
    for (const [x, y] of cellsOf(it)) if (x >= 0 && y >= 0 && x < w && y < d) blocked[y * w + x] = true;
  }
  const out: string[] = [];
  if (doorTiles(w, d).some(([x, y]) => blocked[y * w + x])) out.push("Hay una puerta tapada.");
  const free: number[] = [];
  for (let i = 0; i < blocked.length; i++) if (!blocked[i]) free.push(i);
  if (free.length) {
    const seen = new Set([free[0]]);
    const queue = [free[0]];
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % w;
      const y = Math.floor(i / w);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        const j = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < d && !blocked[j] && !seen.has(j)) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    if (seen.size !== free.length) out.push("Hay rincones a los que no se puede llegar.");
  }
  const stuck = items.filter((it) => {
    if (!FURNITURE[it.kind]?.seat) return false;
    return ![
      [it.x + 1, it.y],
      [it.x - 1, it.y],
      [it.x, it.y + 1],
      [it.x, it.y - 1],
    ].some(([x, y]) => x >= 0 && y >= 0 && x < w && y < d && !blocked[y * w + x]);
  });
  if (stuck.length) out.push(`Nadie puede sentarse en: ${[...new Set(stuck.map((s) => FURNITURE[s.kind].label.toLowerCase()))].join(", ")}.`);
  return out;
}

/**
 * Recoloca automáticamente los mismos muebles (como el decorador al crear la
 * sala). Las parejas silla + escritorio vuelven a ir juntas y se conservan los
 * colores. Lo que no quepa se devuelve en `skipped`.
 */
export function autoArrange(items: FurnitureItem[], ctx: DecorContext): { furniture: FurnitureItem[]; skipped: string[] } {
  const kinds = items.map((it) => it.kind).filter((k) => FURNITURE[k]);
  const count = (k: string) => kinds.filter((x) => x === k).length;
  const list: string[] = [];
  const left: Record<string, number> = {};
  for (const [set, [chair, desk]] of Object.entries(DESK_SETS)) {
    const sets = Math.min(count(chair), count(desk));
    for (let i = 0; i < sets; i++) list.push(set);
    left[chair] = sets;
    left[desk] = sets;
  }
  for (const k of kinds) {
    if (left[k]) left[k]--;
    else list.push(k);
  }
  const { furniture, skipped } = decorate([], list, ctx);
  // Mismos colores que tenían, por orden dentro de cada tipo.
  const tints = new Map<string, (Record<string, string> | undefined)[]>();
  for (const it of items) tints.set(it.kind, [...(tints.get(it.kind) ?? []), it.tint]);
  const out = furniture.map((it) => {
    const tint = tints.get(it.kind)?.shift();
    return tint ? { ...it, tint } : it;
  });
  return { furniture: out, skipped: skipped.flatMap((k) => DESK_SETS[k] ?? [k]) };
}

/** Comprueba una distribución completa que llega de fuera (API). Lanza si no es válida. */
export function assertLayout(items: FurnitureItem[], ctx: Pick<EditContext, "w" | "d">) {
  const ids = new Set<string>();
  for (const it of items) {
    if (!FURNITURE[it.kind]) throw new Error(`No conozco el mueble «${it.kind}».`);
    if (ids.has(it.id)) throw new Error("Hay dos muebles con el mismo id.");
    ids.add(it.id);
    const fp = FURNITURE[it.kind].wall ? { w: 1, d: 1 } : footprint(it.kind, it.flip);
    if (it.x < 0 || it.y < 0 || it.x + fp.w > ctx.w || it.y + fp.d > ctx.d) throw new Error(`${FURNITURE[it.kind].label} se sale de la sala.`);
  }
}
