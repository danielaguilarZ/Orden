/**
 * Modo «decorar» del living (estilo Habbo): lógica pura del arrastre.
 *
 * Traduce un punto del mundo (coordenadas de la escena sin zoom, las de
 * `project`) a la posición que tendría el mueble arrastrado dentro de su sala,
 * conservando el punto por el que se cogió. Las reglas de colocación (sin
 * solapes, sin tapar puertas, adornos solo en muro alto…) siguen en
 * roomEditor.ts; aquí no se decide si cabe.
 */

import { FURNITURE } from "./furniture";
import { FLOOR_T, T, WALL_H, WALL_T } from "./houseRender";
import { cellsOf } from "./roomEditor";
import type { FurnitureItem, Room } from "../lib/types";

export type RoomArea = Pick<Room, "x" | "y" | "w" | "d">;

/** Altura del plano en el que se apoyan los objetos pequeños (encima de mesas). */
export const TOP_PLANE = 16;

/** Pasos que se pueden deshacer en una sesión de decorar. */
export const HISTORY_MAX = 50;

export interface Anchor {
  x: number;
  y: number;
  flip: boolean;
}

/** Lo que se arrastra: un mueble de la sala o uno nuevo del inventario. */
export interface DecorDrag {
  /** Mueble que se mueve; null si viene del inventario. */
  id: string | null;
  kind: string;
  flip: boolean;
  tint?: Record<string, string>;
  /** Desfase entre lo que se cogió (baldosa o tramo de muro) y el anclaje del mueble. */
  offX: number;
  offY: number;
}

/** Sombra del mueble arrastrado: verde si cabe, roja si no. */
export interface DecorGhost {
  kind: string;
  x: number;
  y: number;
  flip: boolean;
  tint?: Record<string, string>;
  /** Altura (objetos encima de una mesa). */
  z?: number;
  ok: boolean;
}

/** Baldosa (relativa a la sala y sin recortar) bajo un punto del mundo a la altura z. */
export function cellAt(room: RoomArea, wx: number, wy: number, z = 0): { x: number; y: number } {
  // Inversa de project(): sx = X − Y, sy = (X + Y) / 2 − Z.
  const X = wy + z + wx / 2;
  const Y = wy + z - wx / 2;
  return { x: Math.floor(X / T) - room.x, y: Math.floor(Y / T) - room.y };
}

/** Tramo de muro bajo un punto del mundo: el norte (y = 0) o, girado, el oeste (x = 0). */
export function wallAt(room: RoomArea, wx: number): Anchor {
  const X0 = room.x * T;
  const Y0 = room.y * T;
  // La esquina del fondo separa los dos muros en la pantalla.
  if (wx >= X0 - Y0) return { x: Math.floor((wx + Y0) / T) - room.x, y: 0, flip: false };
  return { x: 0, y: Math.floor((X0 - wx) / T) - room.y, flip: true };
}

/** Por dónde se coge un mueble de un tipo bajo el puntero. */
function grabAt(room: RoomArea, kind: string, wx: number, wy: number): Anchor {
  const def = FURNITURE[kind];
  if (def?.wall) return wallAt(room, wx);
  return { ...cellAt(room, wx, wy, def?.onTop ? TOP_PLANE : 0), flip: false };
}

/** Empieza a arrastrar un mueble de la sala cogido en el punto (wx, wy). */
export function dragExisting(room: RoomArea, item: FurnitureItem, wx: number, wy: number): DecorDrag {
  const g = grabAt(room, item.kind, wx, wy);
  const base = { id: item.id, kind: item.kind, flip: Boolean(item.flip), ...(item.tint && { tint: item.tint }) };
  if (FURNITURE[item.kind]?.wall) {
    const along = (g.flip ? g.y : g.x) - (item.flip ? item.y : item.x);
    return { ...base, offX: along, offY: 0 };
  }
  return { ...base, offX: g.x - item.x, offY: g.y - item.y };
}

/** Empieza a arrastrar un mueble nuevo del inventario (se coge por su anclaje). */
export function dragNew(kind: string, flip = false): DecorDrag {
  return { id: null, kind, flip, offX: 0, offY: 0 };
}

/**
 * Posición que tendría el mueble arrastrado con el puntero en (wx, wy), o null
 * si el puntero está lejos de la sala (no se enseña sombra ni se suelta).
 */
export function dragTarget(room: RoomArea, drag: DecorDrag, wx: number, wy: number): Anchor | null {
  const def = FURNITURE[drag.kind];
  if (!def) return null;
  if (def.wall) {
    // Por la vertical de los muros: desde el borde alto del muro hasta el suelo de la sala.
    const c = cellAt(room, wx, wy);
    const up = Math.ceil(WALL_H / T) + 1;
    if (c.x < -up || c.y < -up || c.x > room.w || c.y > room.d) return null;
    const g = wallAt(room, wx);
    const along = (g.flip ? g.y : g.x) - drag.offX;
    if (along < -1 || along > (g.flip ? room.d : room.w)) return null;
    return g.flip ? { x: 0, y: along, flip: true } : { x: along, y: 0, flip: false };
  }
  const c = cellAt(room, wx, wy, def.onTop ? TOP_PLANE : 0);
  const x = c.x - drag.offX;
  const y = c.y - drag.offY;
  if (x < -1 || y < -1 || x > room.w || y > room.d) return null;
  return { x, y, flip: drag.flip };
}

/** Baldosas que se resaltan bajo un mueble (los adornos de pared no ocupan suelo). */
export function highlightCells(it: Pick<FurnitureItem, "kind" | "x" | "y" | "flip">): [number, number][] {
  const def = FURNITURE[it.kind];
  if (!def || def.wall) return [];
  if (def.onTop) return [[it.x, it.y]];
  return cellsOf({ id: "", ...it });
}

/** Rectángulo (en coordenadas del mundo) que ocupa una sala con sus muros, para centrar la cámara. */
export function roomBounds(room: RoomArea): { x: number; y: number; width: number; height: number } {
  const X0 = room.x * T;
  const Y0 = room.y * T;
  const X1 = (room.x + room.w) * T;
  const Y1 = (room.y + room.d) * T;
  const left = X0 - Y1 - WALL_T;
  const right = X1 - Y0 + WALL_T;
  const top = (X0 + Y0) / 2 - WALL_H - WALL_T;
  const bottom = (X1 + Y1) / 2 + FLOOR_T;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Añade un estado al historial de «deshacer», sin pasar del máximo. */
export function pushHistory<T>(history: T[], prev: T): T[] {
  return [...history, prev].slice(-HISTORY_MAX);
}
