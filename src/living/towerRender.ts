/**
 * Envolvente de la torre: lo que hace que las plantas se lean como un
 * rascacielos de oficinas y no como salas sueltas en el suelo.
 *
 * Por planta (en coordenadas del plano de esa planta; la capa la sube luego):
 * - Forjado: losa de hormigón bajo toda la huella, con canto visible.
 * - Muro cortina: cristal con montantes, travesaño y franja opaca (antepecho)
 *   bajo el forjado de arriba. Delante (sur y este) tapa la planta, así que la
 *   planta elegida lo oculta (corte de maqueta). Detrás (norte y oeste) solo
 *   va donde no hay muro de sala.
 * - Planta baja: plaza de piedra alrededor. Arriba del todo: azotea con peto.
 */

import { LEVEL_STRIDE, levelOf } from "./house";
import { FLOOR_T, T, WALL_T } from "./houseRender";
import { SLAB_EXTRA, STOREY_H, type Footprint } from "./floors";
import type { RasterBox } from "./raster";
import type { Room } from "../lib/types";

const STEEL = "#2a3038";
const GLASS = "#8fc3d9";
const SPANDREL = "#34404c";
const SLAB = "#7c838c";
const SLAB_TOP = "#a9aeb5";
const PLAZA = "#8b8579";
const PLAZA_TOP = "#c9c3b7";

/** Altura libre bajo el forjado de arriba (de z = 0 al canto inferior del siguiente). */
export const CLEAR_H = STOREY_H - FLOOR_T - SLAB_EXTRA;
/** Antepecho opaco bajo el forjado de arriba. */
const SPANDREL_H = 8;
/** Alto del cristal. */
export const GLASS_H = CLEAR_H - SPANDREL_H;
/** Grosor de los montantes (en unidades; 16 = una baldosa). */
const MULLION = 1.2;

export interface TowerShell {
  /** Forjado (y plaza en la baja): opaco, detrás de todo lo de la planta. */
  slab: RasterBox[];
  /** Cristal y estructura del fondo (norte y oeste) donde no hay muro de sala. */
  backGlass: RasterBox[];
  backFrame: RasterBox[];
  /** Muro cortina delantero (sur y este): delante de todo lo de la planta. */
  frontGlass: RasterBox[];
  frontFrame: RasterBox[];
}

/** Esquinas de la huella en el plano de una planta (en unidades). */
export function shellEdges(fp: Footprint, level: number) {
  const ox = level * LEVEL_STRIDE;
  return { X0: (ox + fp.x0) * T, X1: (ox + fp.x1) * T, Y0: fp.y0 * T, Y1: fp.y1 * T, ox };
}

/** ¿Hay una sala de esta planta en la baldosa local (x, y)? */
function roomOn(rooms: Room[], ox: number, x: number, y: number): boolean {
  return rooms.some((r) => x + ox >= r.x && x + ox < r.x + r.w && y >= r.y && y < r.y + r.d);
}

/** Paño de muro cortina a lo largo de x (en y = Y) o de y (en x = X), una baldosa. */
function pane(axis: "x" | "y", a: number, at: number, glass: RasterBox[], frame: RasterBox[], depth = 0.8) {
  if (axis === "x") {
    glass.push({ x: a, y: at, z: 0, w: T, d: depth, h: GLASS_H, c: GLASS });
    frame.push({ x: a, y: at, z: 0, w: MULLION, d: depth + 0.6, h: CLEAR_H, c: STEEL });
    frame.push({ x: a, y: at, z: GLASS_H, w: T, d: depth + 0.4, h: SPANDREL_H, c: SPANDREL });
  } else {
    glass.push({ x: at, y: a, z: 0, w: depth, d: T, h: GLASS_H, c: GLASS });
    frame.push({ x: at, y: a, z: 0, w: depth + 0.6, d: MULLION, h: CLEAR_H, c: STEEL });
    frame.push({ x: at, y: a, z: GLASS_H, w: depth + 0.4, d: T, h: SPANDREL_H, c: SPANDREL });
  }
}

/** Envolvente de una planta. `rooms`: las salas de ESA planta. */
export function towerShell(fp: Footprint, level: number, rooms: Room[]): TowerShell {
  const { X0, X1, Y0, Y1, ox } = shellEdges(fp, level);
  const mine = rooms.filter((r) => levelOf(r) === level);
  const slab: RasterBox[] = [
    // Losa: cubre también el grueso de los muros del fondo y asoma por delante para el muro cortina.
    { x: X0 - WALL_T, y: Y0 - WALL_T, z: -FLOOR_T - SLAB_EXTRA, w: X1 - X0 + WALL_T + 1.5, d: Y1 - Y0 + WALL_T + 1.5, h: FLOOR_T + SLAB_EXTRA - 0.5, c: SLAB, top: SLAB_TOP },
  ];
  if (level === 0) {
    slab.push({ x: X0 - 3 * T, y: Y0 - 3 * T, z: -FLOOR_T - SLAB_EXTRA - 3, w: X1 - X0 + 6 * T, d: Y1 - Y0 + 6 * T, h: 3, c: PLAZA, top: PLAZA_TOP });
  }

  const backGlass: RasterBox[] = [];
  const backFrame: RasterBox[] = [];
  for (let x = fp.x0; x < fp.x1; x++) {
    if (!roomOn(mine, ox, x, fp.y0)) pane("x", (ox + x) * T, Y0 - WALL_T, backGlass, backFrame);
  }
  for (let y = fp.y0; y < fp.y1; y++) {
    if (!roomOn(mine, ox, fp.x0, y)) pane("y", y * T, X0 - WALL_T, backGlass, backFrame);
  }

  const frontGlass: RasterBox[] = [];
  const frontFrame: RasterBox[] = [];
  for (let x = fp.x0; x < fp.x1; x++) pane("x", (ox + x) * T, Y1, frontGlass, frontFrame);
  for (let y = fp.y0; y < fp.y1; y++) pane("y", y * T, X1, frontGlass, frontFrame);
  // Montante de la esquina y travesaño a media altura.
  frontFrame.push({ x: X1, y: Y1, z: 0, w: 1.4, d: 1.4, h: CLEAR_H, c: STEEL });
  frontFrame.push({ x: X0, y: Y1, z: GLASS_H / 2, w: X1 - X0, d: 1, h: 0.8, c: STEEL });
  frontFrame.push({ x: X1, y: Y0, z: GLASS_H / 2, w: 1, d: Y1 - Y0, h: 0.8, c: STEEL });

  return { slab, backGlass, backFrame, frontGlass, frontFrame };
}

/** Azotea encima de la planta más alta (se dibuja como una planta `level` más). */
export function roofBoxes(fp: Footprint, level: number): RasterBox[] {
  const { X0, X1, Y0, Y1 } = shellEdges(fp, level);
  const W = X1 - X0 + WALL_T + 1.5;
  const D = Y1 - Y0 + WALL_T + 1.5;
  const x = X0 - WALL_T;
  const y = Y0 - WALL_T;
  const z = -FLOOR_T - SLAB_EXTRA;
  const h = FLOOR_T + SLAB_EXTRA;
  return [
    { x, y, z, w: W, d: D, h, c: SLAB, top: "#8e949b" },
    // Peto alrededor.
    { x, y, z: 0, w: W, d: 2, h: 6, c: STEEL },
    { x, y, z: 0, w: 2, d: D, h: 6, c: STEEL },
    { x, y: y + D - 2, z: 0, w: W, d: 2, h: 6, c: STEEL },
    { x: x + W - 2, y, z: 0, w: 2, d: D, h: 6, c: STEEL },
  ];
}
