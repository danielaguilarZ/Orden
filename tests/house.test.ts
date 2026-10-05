import { describe, expect, it } from "vitest";
import { buildNavGrid, canStep, computeDoors, findPath, nextRoomPosition, slotOrder, ROOM_SIZE } from "@/living/house";
import type { Room } from "@/lib/types";

function room(id: string, x: number, y: number, furniture: Room["furniture"] = []): Room {
  return {
    id, name: id, kind: "test", agentId: null, x, y, w: ROOM_SIZE, d: ROOM_SIZE,
    style: { floor: "madera", floorA: "#000", floorB: "#111", wall: "#222", wallTrim: "#333" },
    furniture, createdAt: "", updatedAt: "",
  };
}

describe("plano de la casa", () => {
  it("reparte huecos creciendo en cuadrado", () => {
    expect(slotOrder(5)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 0 }]);
  });

  it("elige la primera posición libre", () => {
    expect(nextRoomPosition([])).toEqual({ x: 0, y: 0 });
    expect(nextRoomPosition([room("a", 0, 0)])).toEqual({ x: 10, y: 0 });
    expect(nextRoomPosition([room("a", 0, 0), room("b", 10, 0)])).toEqual({ x: 0, y: 10 });
  });

  it("pone una puerta centrada entre salas vecinas", () => {
    const doors = computeDoors([room("a", 0, 0), room("b", 10, 0), room("c", 0, 10)]);
    expect(doors).toContainEqual({ axis: "x", at: 10, from: 4, to: 6, rooms: ["a", "b"] });
    expect(doors).toContainEqual({ axis: "y", at: 10, from: 4, to: 6, rooms: ["a", "c"] });
    expect(doors).toHaveLength(2);
  });

  it("solo se cruza de sala por las puertas", () => {
    const g = buildNavGrid([room("a", 0, 0), room("b", 10, 0)]);
    expect(canStep(g, { x: 9, y: 0 }, { x: 10, y: 0 })).toBe(false);
    expect(canStep(g, { x: 9, y: 4 }, { x: 10, y: 4 })).toBe(true);
  });

  it("encuentra camino entre salas pasando por la puerta", () => {
    const g = buildNavGrid([room("a", 0, 0), room("b", 10, 0)]);
    const path = findPath(g, { x: 1, y: 0 }, { x: 15, y: 0 })!;
    expect(path[0]).toEqual({ x: 1, y: 0 });
    expect(path.at(-1)).toEqual({ x: 15, y: 0 });
    const crossing = path.findIndex((p, i) => i > 0 && path[i - 1].x === 9 && p.x === 10);
    expect(crossing).toBeGreaterThan(0);
    expect([4, 5]).toContain(path[crossing].y);
  });

  it("esquiva muebles y permite llegar a un asiento ocupado", () => {
    const g = buildNavGrid([room("a", 0, 0, [{ id: "s", kind: "silla", x: 3, y: 3 }, { id: "e", kind: "estanteria", x: 2, y: 0 }])]);
    const path = findPath(g, { x: 0, y: 0 }, { x: 3, y: 3 })!;
    expect(path.at(-1)).toEqual({ x: 3, y: 3 });
    expect(path.some((p) => p.x === 2 && (p.y === 0 || p.y === 1))).toBe(false);
  });

  it("las alfombras y adornos de pared no bloquean", () => {
    const g = buildNavGrid([room("a", 0, 0, [{ id: "r", kind: "alfombra", x: 0, y: 0 }, { id: "v", kind: "ventana", x: 4, y: 0 }])]);
    expect(findPath(g, { x: 0, y: 0 }, { x: 5, y: 0 })).not.toBeNull();
  });
});
