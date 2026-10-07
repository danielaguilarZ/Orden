/**
 * Plantas apiladas: geometría pura del dibujo de la torre.
 *
 * Cada planta vive en su franja del plano (x desde level × LEVEL_STRIDE, ver
 * house.ts), así que la lógica 2D (caminos, puertas, muros) no cambia. Al
 * dibujar, cada planta va en su propia capa desplazada con `levelOffset`: se
 * devuelve a la huella común y se sube `level` pisos. Con la proyección
 *   sx = X − Y,  sy = (X + Y) / 2 − Z
 * un punto local (x, y, z) de la planta L queda en
 *   sx = (x − y)·T,  sy = (x + y)·T/2 − z − L·STOREY_H,
 * es decir, exactamente encima del mismo punto de la planta baja.
 */

import type { Agent, Room } from "../lib/types";
import { levelOf, levelsOf, LEVEL_STRIDE } from "./house";
import { FLOOR_T, T, WALL_H, WALL_T } from "./houseRender";
import { currentRoom } from "./presence";
import { project } from "./raster";

/** Altura de un piso (de suelo a suelo) en píxeles: el muro más el forjado. */
export const STOREY_H = WALL_H + FLOOR_T;

/** Lo que el forjado baja por debajo del suelo de las salas (se ve como canto entre plantas). */
export const SLAB_EXTRA = 2;

/** Desplazamiento (en coordenadas de `project`, sin zoom) de la capa de una planta. */
export function levelOffset(level: number): { x: number; y: number } {
  const o = project(level * LEVEL_STRIDE * T, 0, 0);
  return { x: -o.sx, y: -o.sy - level * STOREY_H };
}

/** Punto en pantalla (sin zoom) de un punto del plano a la altura z de su planta. */
export function projectOnLevel(X: number, Y: number, Z: number, level: number): { sx: number; sy: number } {
  const p = project(X, Y, Z);
  const o = levelOffset(level);
  return { sx: p.sx + o.x, sy: p.sy + o.y };
}

/** Huella de la torre en baldosas locales (comunes a todas las plantas). */
export interface Footprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Unión de las salas de todas las plantas, devueltas a su huella local. */
export function towerFootprint(rooms: Pick<Room, "x" | "y" | "w" | "d" | "level">[]): Footprint | null {
  if (!rooms.length) return null;
  const local = rooms.map((r) => ({ x: r.x - levelOf(r) * LEVEL_STRIDE, y: r.y, w: r.w, d: r.d }));
  return {
    x0: Math.min(...local.map((r) => r.x)),
    y0: Math.min(...local.map((r) => r.y)),
    x1: Math.max(...local.map((r) => r.x + r.w)),
    y1: Math.max(...local.map((r) => r.y + r.d)),
  };
}

/** Plantas que se dibujan: de la baja a la más alta con salas (las vacías de en medio, diáfanas). */
export function towerLevels(rooms: Pick<Room, "level">[]): number[] {
  const used = levelsOf(rooms);
  if (!used.length) return [];
  const top = Math.max(0, used[used.length - 1]);
  return Array.from({ length: top + 1 }, (_, i) => i);
}

/** Rectángulo en pantalla (sin zoom) de una planta: su huella, del canto del forjado a lo alto del muro. */
export function levelScreenBounds(fp: Footprint, level: number): { x: number; y: number; width: number; height: number } {
  const X0 = fp.x0 * T - WALL_T;
  const Y0 = fp.y0 * T - WALL_T;
  const X1 = fp.x1 * T;
  const Y1 = fp.y1 * T;
  const lift = level * STOREY_H;
  const left = X0 - Y1;
  const right = X1 - Y0;
  const top = (X0 + Y0) / 2 - WALL_H - lift;
  const bottom = (X1 + Y1) / 2 + FLOOR_T + SLAB_EXTRA - lift;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Planta de un punto del plano (por su franja). */
export function levelAtX(x: number): number {
  return Math.floor(x / LEVEL_STRIDE);
}

/**
 * Planta que se enseña al abrir el living: donde más agentes están
 * trabajando; si no hay acción, la más alta con salas (la de Dirección).
 */
export function initialLevel(rooms: Room[], agents: Pick<Agent, "status" | "paused" | "roomId" | "locationRoomId">[]): number {
  const levels = levelsOf(rooms);
  if (!levels.length) return 0;
  const count = new Map<number, number>();
  for (const a of agents) {
    if (a.paused || a.status !== "working") continue;
    const room = currentRoom(a, rooms);
    if (room) count.set(levelOf(room), (count.get(levelOf(room)) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [level, n] of count) if (best === null || n > count.get(best)! || (n === count.get(best) && level > best)) best = level;
  return best ?? levels[levels.length - 1];
}
