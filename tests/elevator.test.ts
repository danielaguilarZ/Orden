import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { hireAgent } from "@/lib/team";
import { assignOwnRoom, buildRoom, describeRooms, placeFurnitureAt } from "@/lib/rooms";
import { getAgent, listAgents } from "@/lib/repo/agents";
import { getRoom, listRooms } from "@/lib/repo/rooms";
import { decorate } from "@/living/decorator";
import { entranceTiles, footprint, FURNITURE } from "@/living/furniture";
import { buildNavGrid, computeElevators, computeWalkways, elevatorStop, findPath } from "@/living/house";
import { BUILDINGS, ROOM_TEMPLATES } from "@/lib/roomTemplates";
import type { FurnitureItem, Room } from "@/lib/types";

function room(id: string, x: number, building: string, furniture: FurnitureItem[] = []): Room {
  return {
    id,
    name: id,
    kind: "x",
    agentId: null,
    building,
    x,
    y: 0,
    w: 10,
    d: 10,
    style: { floor: "madera", floorA: "#000", floorB: "#000", wall: "#000", wallTrim: "#000" },
    furniture,
    createdAt: "",
    updatedAt: "",
  };
}

const lift = (id: string, x: number, y: number, flip = false): FurnitureItem => ({ id, kind: "ascensor", x, y, ...(flip && { flip }) });

describe("ascensor entre plantas (puro)", () => {
  it("la parada es la baldosa libre delante de las puertas", () => {
    expect(elevatorStop([room("a", 0, "orden", [lift("l", 3, 0)])], "orden")).toMatchObject({ x: 3, y: 1, roomId: "a" });
    // Girado mira al este; si la primera baldosa está ocupada, usa la siguiente.
    const blocked = room("a", 0, "orden", [lift("l", 0, 4, true), { id: "p", kind: "planta", x: 1, y: 4 }]);
    expect(elevatorStop([blocked], "orden")).toMatchObject({ x: 1, y: 5 });
    expect(elevatorStop([room("a", 0, "orden")], "orden")).toBeNull();
  });

  it("con ascensor en los dos edificios no hay pasarela; si falta uno, sí", () => {
    const both = [room("a", 0, "orden", [lift("l1", 3, 0)]), room("b", 16, "marketing", [lift("l2", 4, 0)])];
    expect(computeWalkways(both)).toEqual([]);
    expect(computeElevators(both)).toHaveLength(1);
    const onlyOne = [room("a", 0, "orden"), room("b", 16, "marketing", [lift("l2", 4, 0)])];
    expect(computeElevators(onlyOne)).toEqual([]);
    expect(computeWalkways(onlyOne)).toHaveLength(1);
  });

  it("el camino a otra planta salta de un ascensor al otro", () => {
    const rooms = [room("a", 0, "orden", [lift("l1", 3, 0)]), room("b", 16, "marketing", [lift("l2", 4, 0)])];
    const g = buildNavGrid(rooms);
    const path = findPath(g, { x: 8, y: 8 }, { x: 20, y: 8 })!;
    expect(path).not.toBeNull();
    const jumps = path.filter((p) => p.elevator);
    expect(jumps).toEqual([{ x: 20, y: 1, elevator: true }]);
    const before = path[path.indexOf(jumps[0]) - 1];
    expect(before).toEqual({ x: 3, y: 1 });
    // Dentro del mismo edificio no se usa el ascensor.
    expect(findPath(g, { x: 1, y: 8 }, { x: 8, y: 8 })!.some((p) => p.elevator)).toBe(false);
  });
});

describe("planta de marketing", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  it("sus plantillas son de su edificio y la recepción trae el ascensor", () => {
    expect(BUILDINGS.marketing.ascensor).toBe(true);
    const tpls = Object.values(ROOM_TEMPLATES).filter((t) => t.building === "marketing");
    expect(tpls.map((t) => t.kind).sort()).toEqual(["despacho_marketing", "marketing_abierta", "marketing_recepcion"]);
    const open = new Array(10).fill(true);
    const { furniture, skipped } = decorate([], ROOM_TEMPLATES.marketing_recepcion.kinds!, { w: 10, d: 10, northWall: open, westWall: open, seed: "r" });
    expect(skipped).not.toContain("ascensor");
    const lift = furniture.find((f) => f.kind === "ascensor")!;
    // De espaldas al muro y con la entrada libre.
    expect(lift.flip ? lift.x : lift.y).toBe(0);
    const solid = furniture.filter((f) => f !== lift && !FURNITURE[f.kind].walkable && !FURNITURE[f.kind].wall && !FURNITURE[f.kind].onTop);
    for (const p of entranceTiles(lift)) {
      for (const f of solid) {
        const fp = footprint(f.kind, f.flip);
        expect(p.x >= f.x && p.x < f.x + fp.w && p.y >= f.y && p.y < f.y + fp.d, `${f.kind} tapa la entrada`).toBe(false);
      }
    }
  });

  it("las salas del edificio se juntan en una oficina grande y se sube en ascensor", () => {
    const lobby = buildRoom({ name: "Recepción", domain: "recepción con ascensor", building: "marketing" });
    const office = buildRoom({ name: "Despacho de redes", domain: "despacho de redes sociales", building: "marketing" });
    expect(office.kind).toBe("despacho_marketing");
    expect(Math.abs(office.x - lobby.x) + Math.abs(office.y - lobby.y)).toBe(10);
    // Sin ascensor en la casa sigue la pasarela; con él, se sube en ascensor.
    expect(computeWalkways(listRooms())).toHaveLength(1);
    const home = listRooms().find((r) => r.building !== "marketing")!;
    placeFurnitureAt(home.id, "ascensor", { x: 1, y: 0 });
    expect(computeWalkways(listRooms())).toEqual([]);
    expect(computeElevators(listRooms())).toHaveLength(1);
    expect(describeRooms(listRooms(), listAgents(), listAgents()[0])).toMatch(/se sube en ascensor/);
  });

  it("asigna un despacho propio con su puesto y no deja quitárselo a otro", () => {
    const office = buildRoom({ name: "Despacho de copy", domain: "despacho de copy", building: "marketing" });
    const ana = hireAgent({ name: "Ana", specialty: "Copywriting" });
    const leo = hireAgent({ name: "Leo", specialty: "Redes sociales" });
    const oldRoom = ana.roomId;
    const r = assignOwnRoom(office.id, ana.id);
    expect(r.room.agentId).toBe(ana.id);
    const after = getAgent(ana.id)!;
    expect(after.roomId).toBe(office.id);
    expect(getRoom(office.id)!.furniture.some((f) => f.id === after.deskSeatId)).toBe(true);
    expect(oldRoom).not.toBe(office.id);
    expect(() => assignOwnRoom(office.id, leo.id)).toThrow(/despacho de Ana/);
  });
});
