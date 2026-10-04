import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { ROOM_TEMPLATES } from "@/lib/roomTemplates";
import { DEFAULT_STYLE, getRoom, listRooms } from "@/lib/repo/rooms";
import { setRoomFinish } from "@/lib/rooms";
import { applyFinish, currentFloorFinish, currentWallFinish, findFloorFinish, findWallFinish, FLOOR_FINISHES, WALL_FINISHES } from "@/living/finishes";

describe("catálogo de suelos y paredes (puro)", () => {
  it("ids únicos y colores en hexadecimal", () => {
    for (const list of [FLOOR_FINISHES, WALL_FINISHES]) {
      expect(new Set(list.map((f) => f.id)).size).toBe(list.length);
    }
    for (const f of FLOOR_FINISHES) for (const c of [f.floorA, f.floorB]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    for (const w of WALL_FINISHES) for (const c of [w.wall, w.wallTrim]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("todas las plantillas y el estilo por defecto se reconocen como un acabado del catálogo", () => {
    for (const style of [DEFAULT_STYLE, ...Object.values(ROOM_TEMPLATES).map((t) => t.style)]) {
      expect(currentFloorFinish(style), JSON.stringify(style)).not.toBeNull();
      expect(currentWallFinish(style), JSON.stringify(style)).not.toBeNull();
    }
  });

  it("busca por id o nombre, sin tildes; un trozo solo si no es ambiguo", () => {
    expect(findFloorFinish("nogal")?.id).toBe("nogal");
    expect(findFloorFinish("Mármol Blanco")?.id).toBe("marmol_blanco");
    expect(findFloorFinish("moqueta_azul")?.id).toBe("moqueta_azul");
    expect(findFloorFinish("granate")?.id).toBe("moqueta_granate");
    expect(findFloorFinish("moqueta")).toBeUndefined();
    expect(findWallFinish("verde salvia")?.id).toBe("salvia");
    expect(findWallFinish("azul noche")?.id).toBe("azul_noche");
    expect(findWallFinish("fucsia")).toBeUndefined();
  });

  it("aplicar un acabado solo cambia lo indicado", () => {
    const floor = findFloorFinish("tatami")!;
    const s = applyFinish(DEFAULT_STYLE, { floor });
    expect(s).toEqual({ ...DEFAULT_STYLE, floor: "tatami", floorA: floor.floorA, floorB: floor.floorB });
    const wall = findWallFinish("lavanda")!;
    expect(applyFinish(s, { wall })).toMatchObject({ floor: "tatami", wall: wall.wall, wallTrim: wall.wallTrim });
  });
});

describe("cambiar suelo y paredes de una sala", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  it("guarda el suelo y la pared elegidos sin tocar los muebles", () => {
    const room = listRooms()[0];
    const { floor, wall } = setRoomFinish(room.id, { suelo: "Mármol blanco", pared: "azul_noche" });
    expect(floor?.id).toBe("marmol_blanco");
    expect(wall?.id).toBe("azul_noche");
    const after = getRoom(room.id)!;
    expect(currentFloorFinish(after.style)?.id).toBe("marmol_blanco");
    expect(currentWallFinish(after.style)?.id).toBe("azul_noche");
    expect(after.furniture).toEqual(room.furniture);
  });

  it("solo la pared: el suelo se queda", () => {
    const room = listRooms()[0];
    setRoomFinish(room.id, { pared: "rosa palo" });
    const after = getRoom(room.id)!;
    expect(after.style.floorA).toBe(room.style.floorA);
    expect(currentWallFinish(after.style)?.id).toBe("rosa_palo");
  });

  it("rechaza acabados desconocidos o vacíos con la lista de opciones", () => {
    const room = listRooms()[0];
    expect(() => setRoomFinish(room.id, { suelo: "lava" })).toThrow(/Suelos: .*nogal/);
    expect(() => setRoomFinish(room.id, { pared: "fucsia" })).toThrow(/Paredes: .*salvia/);
    expect(() => setRoomFinish(room.id, {})).toThrow(/Indica/);
    expect(getRoom(room.id)!.style).toEqual(room.style);
  });
});
