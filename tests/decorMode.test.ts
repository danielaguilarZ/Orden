import { describe, expect, it } from "vitest";
import { cellAt, dragExisting, dragNew, dragTarget, HISTORY_MAX, highlightCells, pushHistory, roomBounds, TOP_PLANE, wallAt } from "@/living/decorMode";
import { T, WALL_H } from "@/living/houseRender";
import { project } from "@/living/raster";
import type { FurnitureItem } from "@/lib/types";

// Sala desplazada en la casa para comprobar que todo es relativo a ella.
const room = { x: 10, y: 4, w: 10, d: 10 };

/** Punto del mundo en el centro de una baldosa de la sala (a la altura z). */
const at = (tx: number, ty: number, z = 0) => {
  const p = project((room.x + tx + 0.5) * T, (room.y + ty + 0.5) * T, z);
  return [p.sx, p.sy] as const;
};

/** Punto del mundo en el muro norte (columna i) o en el oeste (fila j), a media altura. */
const northWall = (i: number) => project((room.x + i + 0.5) * T, room.y * T, WALL_H / 2);
const westWall = (j: number) => project(room.x * T, (room.y + j + 0.5) * T, WALL_H / 2);

const item = (p: Partial<FurnitureItem> & Pick<FurnitureItem, "kind" | "x" | "y">): FurnitureItem => ({ id: "m1", ...p });

describe("modo decorar: del puntero a la sala", () => {
  it("cellAt invierte la proyección del suelo y del plano de las mesas", () => {
    expect(cellAt(room, ...at(3, 4))).toEqual({ x: 3, y: 4 });
    expect(cellAt(room, ...at(0, 0))).toEqual({ x: 0, y: 0 });
    expect(cellAt(room, ...at(9, 9))).toEqual({ x: 9, y: 9 });
    // Fuera de la sala da coordenadas fuera de rango (sin recortar).
    expect(cellAt(room, ...at(-2, 12))).toEqual({ x: -2, y: 12 });
    const [sx, sy] = at(6, 2, TOP_PLANE);
    expect(cellAt(room, sx, sy, TOP_PLANE)).toEqual({ x: 6, y: 2 });
  });

  it("wallAt distingue el muro norte del oeste por la esquina del fondo", () => {
    expect(wallAt(room, northWall(6).sx)).toEqual({ x: 6, y: 0, flip: false });
    expect(wallAt(room, northWall(0).sx)).toEqual({ x: 0, y: 0, flip: false });
    expect(wallAt(room, westWall(2).sx)).toEqual({ x: 0, y: 2, flip: true });
    expect(wallAt(room, westWall(9).sx)).toEqual({ x: 0, y: 9, flip: true });
  });

  it("un mueble se arrastra conservando el punto por el que se cogió", () => {
    const desk = item({ kind: "escritorio", x: 2, y: 3 });
    // Se coge por su segunda baldosa.
    const drag = dragExisting(room, desk, ...at(3, 3));
    expect(drag).toMatchObject({ id: "m1", kind: "escritorio", flip: false, offX: 1, offY: 0 });
    expect(dragTarget(room, drag, ...at(6, 5))).toEqual({ x: 5, y: 5, flip: false });
    // Girado mientras se arrastra.
    expect(dragTarget(room, { ...drag, flip: true }, ...at(6, 5))).toEqual({ x: 5, y: 5, flip: true });
    // Lejos de la sala no hay sombra.
    expect(dragTarget(room, drag, ...at(25, 25))).toBeNull();
    // Justo en el borde sí (para enseñarla en rojo).
    expect(dragTarget(room, drag, ...at(10, 4))).toEqual({ x: 9, y: 4, flip: false });
  });

  it("lo nuevo del inventario se coge por su anclaje; los objetos pequeños, a la altura de la mesa", () => {
    expect(dragTarget(room, dragNew("planta"), ...at(1, 1))).toEqual({ x: 1, y: 1, flip: false });
    expect(dragTarget(room, dragNew("planta", true), ...at(1, 1))).toEqual({ x: 1, y: 1, flip: true });
    expect(dragTarget(room, dragNew("taza"), ...at(4, 7, TOP_PLANE))).toEqual({ x: 4, y: 7, flip: false });
    expect(dragTarget(room, dragNew("no_existe"), ...at(1, 1))).toBeNull();
  });

  it("los adornos de pared siguen al puntero por los dos muros", () => {
    const n = northWall(6);
    expect(dragTarget(room, dragNew("cuadro"), n.sx, n.sy)).toEqual({ x: 6, y: 0, flip: false });
    const w = westWall(3);
    expect(dragTarget(room, dragNew("cuadro"), w.sx, w.sy)).toEqual({ x: 0, y: 3, flip: true });
    // Pasar de un muro a otro con uno ya colgado: se coge por donde está.
    const pic = dragExisting(room, item({ kind: "cuadro", x: 4, y: 0 }), northWall(4).sx, northWall(4).sy);
    expect(pic.offX).toBe(0);
    expect(dragTarget(room, pic, w.sx, w.sy)).toEqual({ x: 0, y: 3, flip: true });
    // Muy por debajo de la sala no se cuelga nada.
    expect(dragTarget(room, dragNew("cuadro"), ...at(5, 30))).toBeNull();
  });

  it("baldosas resaltadas: huella de suelo, la casilla del objeto pequeño y nada en la pared", () => {
    expect(highlightCells({ kind: "escritorio", x: 2, y: 3 })).toEqual([
      [2, 3],
      [3, 3],
    ]);
    expect(highlightCells({ kind: "escritorio", x: 2, y: 3, flip: true })).toEqual([
      [2, 3],
      [2, 4],
    ]);
    expect(highlightCells({ kind: "taza", x: 5, y: 5 })).toEqual([[5, 5]]);
    expect(highlightCells({ kind: "cuadro", x: 5, y: 0 })).toEqual([]);
  });

  it("roomBounds abarca el suelo y lo alto de los muros", () => {
    const b = roomBounds({ x: 0, y: 0, w: 10, d: 10 });
    expect(b).toEqual({ x: -164, y: -66, width: 328, height: 232 });
    for (const [X, Y, Z] of [
      [0, 0, WALL_H],
      [160, 0, 0],
      [0, 160, 0],
      [160, 160, 0],
    ]) {
      const p = project(X, Y, Z);
      expect(p.sx).toBeGreaterThanOrEqual(b.x);
      expect(p.sx).toBeLessThanOrEqual(b.x + b.width);
      expect(p.sy).toBeGreaterThanOrEqual(b.y);
      expect(p.sy).toBeLessThanOrEqual(b.y + b.height);
    }
  });

  it("el historial de deshacer no pasa del máximo", () => {
    let h: number[] = [];
    for (let i = 0; i < HISTORY_MAX + 7; i++) h = pushHistory(h, i);
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0]).toBe(7);
    expect(h[h.length - 1]).toBe(HISTORY_MAX + 6);
  });
});
