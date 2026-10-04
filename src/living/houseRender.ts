/**
 * Geometría de la casa para pintar: suelos con patrón, paredes exteriores
 * altas y tabiques bajos entre salas (con hueco de puerta).
 */

import type { Room, RoomStyle } from "../lib/types";
import { buildingOf, computeDoors, computeWalkways, type Door, type Walkway } from "./house";
import { hash2, hexToRgb, rasterizeBoxes, shade, type PixelImage, type RasterBox, type RGB } from "./raster";

export const T = 16;
export const WALL_H = 62;
export const WALL_T = 4;
export const DIVIDER_H = 9;
export const FLOOR_T = 6;

export function floorPattern(style: RoomStyle, ox: number, oy: number): (X: number, Y: number) => RGB {
  const A = hexToRgb(style.floorA);
  const B = hexToRgb(style.floorB);
  const seam = shade(B, 0.82);
  switch (style.floor) {
    case "madera":
      return (X, Y) => {
        const lx = X - ox;
        const ly = Y - oy;
        const row = Math.floor(ly / 4);
        const off = (row * 11) % 32;
        const board = Math.floor((lx + off) / 32);
        if (ly % 4 < 0.9) return seam;
        if ((lx + off) % 32 < 0.9) return seam;
        const base = hash2(row, board) > 0.5 ? A : B;
        return hash2(lx, ly) > 0.93 ? shade(base, 0.94) : base;
      };
    case "baldosa":
      return (X, Y) => {
        const lx = X - ox;
        const ly = Y - oy;
        if (lx % T < 0.9 || ly % T < 0.9) return seam;
        return (Math.floor(lx / T) + Math.floor(ly / T)) % 2 ? A : B;
      };
    case "tatami":
      return (X, Y) => {
        const lx = X - ox;
        const ly = Y - oy;
        const tx = Math.floor(lx / T);
        const ty = Math.floor(ly / T);
        const horizontal = (Math.floor(tx / 2) + ty) % 2 === 0;
        const mx = horizontal ? lx % (2 * T) : lx % T;
        const my = horizontal ? ly % T : ly % (2 * T);
        const w = horizontal ? 2 * T : T;
        const d = horizontal ? T : 2 * T;
        if (mx < 1.2 || my < 1.2 || mx > w - 1.2 || my > d - 1.2) return [62, 90, 58];
        return Math.floor((horizontal ? ly : lx) / 2) % 2 ? A : B;
      };
    case "mármol":
      return (X, Y) => {
        const lx = X - ox;
        const ly = Y - oy;
        if (lx % T < 0.7 || ly % T < 0.7) return seam;
        const base = (Math.floor(lx / T) + Math.floor(ly / T)) % 2 ? A : B;
        const vein = Math.abs(Math.sin((lx + ly * 0.6) * 0.35 + Math.sin(ly * 0.2) * 2));
        return vein < 0.06 ? shade(base, 0.85) : base;
      };
    case "hormigón":
      // Microcemento en losas grandes (2×2 baldosas) con un moteado suave.
      return (X, Y) => {
        const lx = X - ox;
        const ly = Y - oy;
        if (lx % (2 * T) < 0.8 || ly % (2 * T) < 0.8) return seam;
        const base = hash2(Math.floor(lx / (2 * T)), Math.floor(ly / (2 * T)) + 7) > 0.5 ? A : B;
        const n = hash2(X * 0.9, Y * 1.1);
        return n > 0.9 ? shade(base, 0.96) : n < 0.05 ? shade(base, 1.04) : base;
      };
    case "moqueta":
    default:
      return (X, Y) => {
        const n = hash2(X * 1.7, Y * 1.3);
        return n > 0.85 ? B : n < 0.08 ? shade(A, 1.05) : A;
      };
  }
}

function roomAt(rooms: Room[], tx: number, ty: number): Room | undefined {
  return rooms.find((r) => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.d);
}

function inDoor(doors: Door[], axis: "x" | "y", at: number, along: number): boolean {
  return doors.some((d) => d.axis === axis && d.at === at && along >= d.from && along < d.to);
}

export interface WallSides {
  /** Muros altos en el lado norte de la sala (sin vecino). */
  north: boolean[];
  west: boolean[];
}

/**
 * Qué baldosas del borde norte/oeste de una sala llevan muro alto: las que no
 * tienen al lado otra sala del mismo edificio ni la entrada de una pasarela.
 */
export function outerWallSides(room: Room, rooms: Room[], walkways: Walkway[] = computeWalkways(rooms)): WallSides {
  const mates = rooms.filter((o) => buildingOf(o) === buildingOf(room));
  const north: boolean[] = [];
  const west: boolean[] = [];
  for (let i = 0; i < room.w; i++) north.push(!roomAt(mates, room.x + i, room.y - 1));
  for (let j = 0; j < room.d; j++) west.push(!roomAt(mates, room.x - 1, room.y + j));
  for (const w of walkways) {
    if (w.rooms[1] !== room.id) continue;
    if (w.axis === "x" && w.x + w.w === room.x) for (let j = w.y; j < w.y + w.d; j++) west[j - room.y] = false;
    if (w.axis === "y" && w.y + w.d === room.y) for (let i = w.x; i < w.x + w.w; i++) north[i - room.x] = false;
  }
  return { north, west };
}

// ───────────── Pasarela acristalada elevada entre edificios ─────────────
// Sustituye a la antigua calle (césped, adoquines, farolas y tótem): un pasillo
// de cristal colgado entre los dos edificios, con estructura fina oscura, suelo
// interior claro y luces cálidas. Los edificios siguen separados por el vacío.

/** Altura interior de la pasarela: coincide con el dintel de la entrada. */
export const BRIDGE_H = 44;
const STEEL = "#2c3138";
const STEEL_LIGHT = "#4a525d";
const GLASS = "#bfe2ee";
const LIGHT = "#ffe3a3";
const BRIDGE_FLOOR_A = hexToRgb("#d3cec4");
const BRIDGE_FLOOR_B = hexToRgb("#c8c3b8");
const BRIDGE_SEAM = hexToRgb("#a59f93");
const LED = hexToRgb("#ffd98a");
/** Transparencia de los cristales laterales y del techo. */
export const GLASS_ALPHA = 0.3;
const ROOF_ALPHA = 0.14;
/** Grosor del perfil de la estructura (en unidades; 16 = una baldosa). */
const FRAME = 1.5;

type BoxRest = Omit<RasterBox, "x" | "y" | "z" | "w" | "d" | "h">;

/**
 * Ejes locales de una pasarela: «a» a lo largo y «c» de lado a lado (en
 * unidades). `box` traduce una caja local a coordenadas de la casa.
 */
function bridgeAxes(w: Walkway) {
  const x = w.axis === "x";
  const along0 = x ? w.x : w.y;
  const across0 = x ? w.y : w.x;
  const len = x ? w.w : w.d;
  const width = x ? w.d : w.w;
  const box = (a: number, c: number, z: number, la: number, lc: number, h: number, rest: BoxRest): RasterBox =>
    x ? { x: a, y: c, z, w: la, d: lc, h, ...rest } : { x: c, y: a, z, w: lc, d: la, h, ...rest };
  return { along0, across0, len, width, a0: along0 * T, c0: across0 * T, c1: (across0 + width) * T, box };
}

/**
 * Lámparas del techo: posición de cada una a lo largo de la pasarela (en
 * baldosas desde su inicio), cada 2 baldosas y simétricas respecto al centro.
 */
export function bridgeLights(len: number): number[] {
  let start = (len / 2) % 2;
  if (start < 0.5) start += 1;
  const out: number[] = [];
  for (let p = start; p < len; p += 2) out.push(p);
  return out;
}

/** Suelo interior: losas claras, tira de luz cálida en cada lateral y halos bajo las lámparas. */
function bridgeFloorPattern(w: Walkway): (X: number, Y: number) => RGB {
  const { a0, c0, c1, len } = bridgeAxes(w);
  const lamps = bridgeLights(len).map((p) => a0 + p * T);
  const mid = (c0 + c1) / 2;
  return (X, Y) => {
    const a = w.axis === "x" ? X : Y;
    const c = w.axis === "x" ? Y : X;
    if (c - c0 < 2.6 || c1 - c < 2.6) return c - c0 < 1.2 || c1 - c < 1.2 ? shade(LED, 0.8) : LED;
    if ((a - a0) % T < 0.8 || (c - c0) % T < 0.8) return BRIDGE_SEAM;
    const base = hash2(Math.floor((a - a0) / T), Math.floor((c - c0) / T) + 3) > 0.5 ? BRIDGE_FLOOR_A : BRIDGE_FLOOR_B;
    const glow = Math.min(...lamps.map((l) => Math.hypot(a - l, (c - mid) * 1.4)));
    return glow < 7 ? shade(base, 1.1) : glow < 11 ? shade(base, 1.05) : base;
  };
}

/** Fondo de la pasarela: losa del suelo, viga inferior (va colgada en altura) y dintel de la entrada. */
function bridgeBoxes(w: Walkway, rooms: Room[]): RasterBox[] {
  const { a0, c0, c1, len, box } = bridgeAxes(w);
  const la = len * T;
  const boxes: RasterBox[] = [
    box(a0, c0, -FLOOR_T, la, c1 - c0, FLOOR_T, { c: STEEL_LIGHT, topFn: bridgeFloorPattern(w) }),
    // Vigas de canto bajo los laterales y un larguero central: se ve que no apoya en el suelo.
    box(a0, c0 + 1, -FLOOR_T - 8, la, 3, 8, { c: STEEL }),
    box(a0, c1 - 4, -FLOOR_T - 8, la, 3, 8, { c: STEEL }),
    box(a0, (c0 + c1) / 2 - 1.5, -FLOOR_T - 4, la, 3, 4, { c: STEEL }),
  ];
  // Riostras bajo el suelo en cada junta de baldosa.
  for (let i = 0; i <= len; i++) boxes.push(box(Math.min(a0 + i * T, a0 + la - 2), c0 + 1, -FLOOR_T - 3, 2, c1 - c0 - 2, 3, { c: STEEL }));
  // Dintel sobre la entrada del edificio de llegada (el muro alto tiene el hueco).
  const dest = rooms.find((r) => r.id === w.rooms[1]);
  if (dest) {
    if (w.axis === "x" && w.x + w.w === dest.x)
      boxes.push({ x: dest.x * T - WALL_T, y: w.y * T, z: BRIDGE_H, w: WALL_T, d: w.d * T, h: WALL_H - BRIDGE_H, c: dest.style.wallTrim, top: dest.style.wallTrim });
    if (w.axis === "y" && w.y + w.d === dest.y)
      boxes.push({ x: w.x * T, y: dest.y * T - WALL_T, z: BRIDGE_H, w: w.w * T, d: WALL_T, h: WALL_H - BRIDGE_H, c: dest.style.wallTrim, top: dest.style.wallTrim });
  }
  return boxes;
}

/**
 * Piezas de la pasarela que se ordenan con los agentes, una por baldosa y
 * lado: estructura (opaca) y cristal (translúcido) del lateral del fondo
 * (detrás de quien cruza), del lateral delantero (delante) y del techo.
 */
export function bridgePieces(w: Walkway): ExteriorPiece[] {
  const { along0, across0, len, width, a0, c0, c1, box } = bridgeAxes(w);
  const out: ExteriorPiece[] = [];
  const lamps = bridgeLights(len);
  const mid = (c0 + c1) / 2;
  const side = (c: number, depth: number, i: number) => {
    const a = a0 + i * T;
    const last = i === len - 1;
    const frame: RasterBox[] = [
      box(a, c, 0, FRAME, FRAME, BRIDGE_H, { c: STEEL }),
      box(a, c, 0, T, FRAME, 2, { c: STEEL }),
      box(a, c, BRIDGE_H - 2.5, T, FRAME, 2.5, { c: STEEL, top: STEEL_LIGHT }),
      box(a, c, 22, T, FRAME * 0.6, 1, { c: STEEL_LIGHT }),
    ];
    if (last) frame.push(box(a + T - FRAME, c, 0, FRAME, FRAME, BRIDGE_H, { c: STEEL }));
    out.push({ boxes: frame, depth });
    out.push({ boxes: [box(a + FRAME, c + 0.3, 2, T - FRAME, 0.9, BRIDGE_H - 4.5, { c: GLASS })], depth: depth - 0.01, alpha: GLASS_ALPHA, outline: false });
  };
  for (let i = 0; i < len; i++) {
    const tile = along0 + i;
    side(c0, tile + across0 + 0.4, i);
    side(c1 - FRAME, tile + across0 + width + 0.5, i);
    // Techo: vidrio muy claro, travesaños cada baldosa y lámparas colgadas.
    const a = a0 + i * T;
    const roofDepth = tile + across0 + width + 1;
    out.push({ boxes: [box(a, c0, BRIDGE_H - 1, T, c1 - c0, 1, { c: GLASS })], depth: roofDepth, alpha: ROOF_ALPHA, outline: false });
    const roof: RasterBox[] = [box(a, c0, BRIDGE_H - 2, FRAME, c1 - c0, 2, { c: STEEL })];
    if (i === len - 1) roof.push(box(a + T - FRAME, c0, BRIDGE_H - 2, FRAME, c1 - c0, 2, { c: STEEL }));
    for (const p of lamps.filter((p) => Math.min(len - 1, Math.floor(p)) === i)) {
      const la = a0 + p * T;
      roof.push(box(la - 0.5, mid - 0.5, BRIDGE_H - 6, 1, 1, 5, { c: STEEL }));
      roof.push(box(la - 3, mid - 3, BRIDGE_H - 8, 6, 6, 2, { c: LIGHT, top: "#fff6d8" }));
    }
    out.push({ boxes: roof, depth: roofDepth + 0.01 });
  }
  return out;
}

/** Suelos y muros altos: el fondo estático de la casa (y las pasarelas entre edificios). */

export function backgroundBoxes(rooms: Room[]): RasterBox[] {
  const boxes: RasterBox[] = [];
  const walkways = computeWalkways(rooms);
  for (const w of walkways) boxes.push(...bridgeBoxes(w, rooms));
  for (const r of rooms) {
    const floorSide = shade(hexToRgb(r.style.floorB), 0.7);
    boxes.push({
      x: r.x * T,
      y: r.y * T,
      z: -FLOOR_T,
      w: r.w * T,
      d: r.d * T,
      h: FLOOR_T,
      c: "#" + floorSide.map((v) => v.toString(16).padStart(2, "0")).join(""),
      topFn: floorPattern(r.style, r.x * T, r.y * T),
    });
    const sides = outerWallSides(r, rooms, walkways);
    const wall = r.style.wall;
    const trim = r.style.wallTrim;
    sides.north.forEach((on, i) => {
      if (!on) return;
      const x = (r.x + i) * T;
      const y = r.y * T - WALL_T;
      boxes.push({ x, y, z: -FLOOR_T, w: T, d: WALL_T, h: WALL_H + FLOOR_T, c: wall, top: trim });
      boxes.push({ x, y: y + WALL_T, z: 0, w: T, d: 1, h: 4, c: trim });
    });
    sides.west.forEach((on, j) => {
      if (!on) return;
      const x = r.x * T - WALL_T;
      const y = (r.y + j) * T;
      boxes.push({ x, y, z: -FLOOR_T, w: WALL_T, d: T, h: WALL_H + FLOOR_T, c: wall, top: trim });
      boxes.push({ x: x + WALL_T, y, z: 0, w: 1, d: T, h: 4, c: trim });
    });
    if (sides.north[0] && sides.west[0]) {
      boxes.push({ x: r.x * T - WALL_T, y: r.y * T - WALL_T, z: -FLOOR_T, w: WALL_T, d: WALL_T, h: WALL_H + FLOOR_T, c: wall, top: trim });
    }
  }
  return boxes;
}

export function renderBackground(rooms: Room[]): PixelImage {
  return rasterizeBoxes(backgroundBoxes(rooms), { outline: true, outlineShade: 0.35 });
}

export interface DividerPiece {
  box: RasterBox;
  /** Clave de profundidad para ordenar con muebles y agentes. */
  depth: number;
}

export interface ExteriorPiece {
  boxes: RasterBox[];
  depth: number;
  /** Opacidad del sprite (cristales); por defecto, opaco. */
  alpha?: number;
  /** Contorno oscuro de 1 px (por defecto sí; el cristal va sin él). */
  outline?: boolean;
}

/** Piezas entre edificios que se ordenan con los agentes: la pasarela acristalada de cada uno. */
export function exteriorPieces(rooms: Room[]): ExteriorPiece[] {
  return computeWalkways(rooms).flatMap(bridgePieces);
}

/** Tabiques bajos entre salas vecinas, una pieza por baldosa (sin puertas). */
export function dividerPieces(rooms: Room[]): DividerPiece[] {
  const doors = computeDoors(rooms);
  const out: DividerPiece[] = [];
  for (const r of rooms) {
    const color = r.style.wallTrim;
    for (let i = 0; i < r.w; i++) {
      const tx = r.x + i;
      const other = roomAt(rooms, tx, r.y - 1);
      if (!other || inDoor(doors, "y", r.y, tx)) continue;
      out.push({ box: { x: tx * T, y: r.y * T - 2, z: 0, w: T, d: 4, h: DIVIDER_H, c: color }, depth: tx + 0.5 + r.y });
    }
    for (let j = 0; j < r.d; j++) {
      const ty = r.y + j;
      const other = roomAt(rooms, r.x - 1, ty);
      if (!other || inDoor(doors, "x", r.x, ty)) continue;
      out.push({ box: { x: r.x * T - 2, y: ty * T, z: 0, w: 4, d: T, h: DIVIDER_H, c: color }, depth: r.x + ty + 0.5 });
    }
  }
  return out;
}
