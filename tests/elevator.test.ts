import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { hireAgent } from "@/lib/team";
import { assignOwnRoom, buildRoom, describeRooms } from "@/lib/rooms";
import { getAgent, listAgents } from "@/lib/repo/agents";
import { getRoom, listRooms } from "@/lib/repo/rooms";
import { decorate } from "@/living/decorator";
import { entranceTiles, footprint, FURNITURE } from "@/living/furniture";
import { buildNavGrid, computeElevators, computeWalkways, elevatorStop, findPath, LEVEL_STRIDE, levelOf, levelOrigin } from "@/living/house";
import { checkRoomRemoval } from "@/living/roomRemoval";
import { BUILDINGS, ROOM_TEMPLATES } from "@/lib/roomTemplates";
import type { FurnitureItem, Room } from "@/lib/types";

/** Sala de 10×10 en la planta `level`, a `lx` baldosas de la esquina de esa planta. */
function room(id: string, lx: number, level: number, furniture: FurnitureItem[] = [], building = "orden"): Room {
  return {
    id,
    name: id,
    kind: "x",
    agentId: null,
    building,
    level,
    x: level * LEVEL_STRIDE + lx,
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

describe("núcleo de ascensores (puro)", () => {
  it("la parada es la baldosa libre delante de las puertas de su planta", () => {
    expect(elevatorStop([room("a", 0, 1, [lift("l", 3, 0)])], 1)).toMatchObject({ x: LEVEL_STRIDE + 3, y: 1, roomId: "a", level: 1 });
    // Girado mira al este; si la primera baldosa está ocupada, usa la siguiente.
    const blocked = room("a", 0, 0, [lift("l", 0, 4, true), { id: "p", kind: "planta", x: 1, y: 4 }]);
    expect(elevatorStop([blocked], 0)).toMatchObject({ x: 1, y: 5 });
    expect(elevatorStop([room("a", 0, 0)], 0)).toBeNull();
    // Solo cuenta el de esa planta.
    expect(elevatorStop([room("a", 0, 1, [lift("l", 3, 0)])], 0)).toBeNull();
  });

  it("une cada par de plantas con parada y entre plantas no hay pasarela", () => {
    const tower = [room("b", 0, 0, [lift("l0", 3, 0)]), room("t", 0, 1, [lift("l1", 3, 0)]), room("m", 0, 2, [lift("l2", 3, 0)])];
    const links = computeElevators(tower);
    expect(links.map((l) => l.stops.map((s) => s.level))).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
    expect(computeWalkways(tower)).toEqual([]);
    // Una planta sin ascensor queda fuera del núcleo.
    expect(computeElevators([tower[0], room("t", 0, 1), tower[2]])).toHaveLength(1);
  });

  it("el camino a otra planta va al ascensor, salta y sigue en la otra planta", () => {
    const rooms = [room("t", 0, 1, [lift("l1", 3, 0)]), room("t2", 10, 1), room("m", 0, 2, [lift("l2", 4, 0)])];
    const g = buildNavGrid(rooms);
    const start = { x: LEVEL_STRIDE + 15, y: 8 };
    const goal = { x: 2 * LEVEL_STRIDE + 6, y: 8 };
    const path = findPath(g, start, goal)!;
    expect(path).not.toBeNull();
    const jumps = path.filter((p) => p.elevator);
    expect(jumps).toEqual([{ x: 2 * LEVEL_STRIDE + 4, y: 1, elevator: true }]);
    expect(path[path.indexOf(jumps[0]) - 1]).toEqual({ x: LEVEL_STRIDE + 3, y: 1 });
    // Dentro de una misma planta no se usa el ascensor.
    expect(findPath(g, start, { x: LEVEL_STRIDE + 1, y: 8 })!.some((p) => p.elevator)).toBe(false);
  });

  it("no deja borrar la sala con el único ascensor de su planta", () => {
    const rooms = [room("t", 0, 1, [lift("l1", 3, 0)]), room("t2", 10, 1), room("m", 0, 2, [lift("l2", 3, 0)], "marketing")];
    expect(checkRoomRemoval(rooms[0], rooms, []).blocked).toMatch(/ascensor/);
    expect(checkRoomRemoval(rooms[1], rooms, []).blocked).toBeNull();
  });
});

describe("plantas en la base de datos", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  it("el despacho inicial está en la planta principal, en la esquina de su franja", () => {
    const [zen] = listRooms();
    expect(levelOf(zen)).toBe(BUILDINGS.orden.level);
    expect([zen.x, zen.y]).toEqual([levelOrigin(BUILDINGS.orden.level).x, 0]);
  });

  it("las salas de marketing van a su planta, apiladas sobre la misma esquina, y cada planta recibe ascensor", () => {
    const lobby = buildRoom({ name: "Recepción", domain: "recepción con ascensor", building: "marketing" });
    const office = buildRoom({ name: "Despacho de redes", domain: "despacho de redes sociales", building: "marketing" });
    expect(office.kind).toBe("despacho_marketing");
    expect(levelOf(lobby)).toBe(2);
    expect([lobby.x, lobby.y]).toEqual([levelOrigin(2).x, 0]);
    expect(Math.abs(office.x - lobby.x) + Math.abs(office.y - lobby.y)).toBe(10);
    // La planta principal recibe su ascensor sola y no hay pasarela.
    const principal = listRooms().filter((r) => levelOf(r) === 1);
    expect(principal.flatMap((r) => r.furniture).filter((f) => f.kind === "ascensor")).toHaveLength(1);
    expect(computeWalkways(listRooms())).toEqual([]);
    expect(computeElevators(listRooms())).toHaveLength(1);
    const g = buildNavGrid(listRooms());
    const zen = principal[0];
    expect(findPath(g, { x: zen.x + 5, y: zen.y + 8 }, { x: office.x + 5, y: office.y + 8 })?.some((p) => p.elevator)).toBe(true);
    expect(describeRooms(listRooms(), listAgents(), listAgents()[0])).toMatch(/Planta 2 · Marketing[\s\S]*Planta 1 · Oficina/);
  });

  it("sus plantillas son de su zona y la recepción trae el ascensor con la entrada libre", () => {
    const tpls = Object.values(ROOM_TEMPLATES).filter((t) => t.building === "marketing");
    expect(tpls.map((t) => t.kind).sort()).toEqual(["despacho_marketing", "marketing_abierta", "marketing_recepcion"]);
    const open = new Array(10).fill(true);
    const { furniture, skipped } = decorate([], ROOM_TEMPLATES.marketing_recepcion.kinds!, { w: 10, d: 10, northWall: open, westWall: open, seed: "r" });
    expect(skipped).not.toContain("ascensor");
    const lift = furniture.find((f) => f.kind === "ascensor")!;
    expect(lift.flip ? lift.x : lift.y).toBe(0);
    const solid = furniture.filter((f) => f !== lift && !FURNITURE[f.kind].walkable && !FURNITURE[f.kind].wall && !FURNITURE[f.kind].onTop);
    for (const p of entranceTiles(lift)) {
      for (const f of solid) {
        const fp = footprint(f.kind, f.flip);
        expect(p.x >= f.x && p.x < f.x + fp.w && p.y >= f.y && p.y < f.y + fp.d, `${f.kind} tapa la entrada`).toBe(false);
      }
    }
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
