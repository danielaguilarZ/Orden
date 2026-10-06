import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { decorate, removeKinds } from "@/living/decorator";
import { autoArrange, checkItem, duplicateItem, layoutWarnings, moveItem, placeNear, placeNew, removeItem, rotateItem } from "@/living/roomEditor";
import { getRoom, listRooms } from "@/lib/repo/rooms";
import { buildRoom, redecorateRoom, setRoomLayout } from "@/lib/rooms";
import type { FurnitureItem } from "@/lib/types";

const open = (n = 10) => new Array(n).fill(true);
const ctx = { w: 10, d: 10, northWall: open(), westWall: open() };
const at = (items: FurnitureItem[], id: string) => items.find((f) => f.id === id)!;

describe("editor de sala: colocar", () => {
  it("coloca a mano y marca el mueble como manual", () => {
    const r = placeNew([], "sillon", 7, 7, false, ctx);
    expect(r.error).toBeUndefined();
    expect(r.furniture).toHaveLength(1);
    expect(r.furniture[0]).toMatchObject({ kind: "sillon", x: 7, y: 7, manual: true });
  });

  it("no deja solapar, salirse ni tapar puertas", () => {
    const { furniture } = placeNew([], "sofa", 2, 2, false, ctx);
    expect(placeNew(furniture, "planta", 2, 3, false, ctx).error).toMatch(/Choca/);
    expect(placeNew(furniture, "escritorio", 9, 2, false, ctx).error).toMatch(/sale/);
    expect(placeNew(furniture, "planta", -1, 2, false, ctx).error).toMatch(/sale/);
    // Las puertas están en el centro de cada lado (baldosas 4 y 5).
    expect(placeNew(furniture, "planta", 4, 0, false, ctx).error).toMatch(/puerta/);
    expect(placeNew(furniture, "planta", 0, 5, false, ctx).error).toMatch(/puerta/);
  });

  it("las alfombras van debajo de los muebles pero no sobre otra alfombra", () => {
    let items = placeNew([], "sillon", 3, 3, false, ctx).furniture;
    const rug = placeNew(items, "alfombra", 3, 3, false, ctx);
    expect(rug.error).toBeUndefined();
    items = rug.furniture;
    expect(placeNew(items, "alfombra", 3, 3, false, ctx).error).toMatch(/Choca/);
    // Y una alfombra no tapa puertas (se pisa).
    expect(placeNew([], "alfombra", 4, 0, false, ctx).error).toBeUndefined();
  });

  it("adornos de pared: solo en muro alto, sin solaparse; girar cambia de pared", () => {
    const noNorth = { ...ctx, northWall: new Array(10).fill(false) };
    expect(placeNew([], "cuadro", 3, 0, false, noNorth).error).toMatch(/muro/);
    const r = placeNew([], "cuadro", 3, 0, false, ctx);
    expect(r.error).toBeUndefined();
    expect(placeNew(r.furniture, "reloj", 3, 0, false, ctx).error).toMatch(/Choca/);
    // Un adorno de pared no ocupa suelo.
    expect(placeNew(r.furniture, "planta", 3, 0, false, ctx).error).toBeUndefined();
    const rot = rotateItem(r.furniture, r.id!, ctx);
    expect(at(rot.furniture, r.id!)).toMatchObject({ x: 0, y: 3, flip: true });
  });

  it("duplicar pone uno igual (tipo, giro y colores) en el hueco libre más cercano", () => {
    let items = placeNew([], "sofa", 2, 2, true, ctx, { $tela: "#123456" }).furniture;
    const id = items[0].id;
    const r = duplicateItem(items, id, ctx);
    expect(r.error).toBeUndefined();
    const copy = at(r.furniture, r.id!);
    expect(copy).toMatchObject({ kind: "sofa", flip: true, tint: { $tela: "#123456" }, manual: true });
    expect(copy.id).not.toBe(id);
    // Pegado al original: a una baldosa de distancia.
    expect(Math.abs(copy.x - 2) + Math.abs(copy.y - 2)).toBe(1);
    items = r.furniture;
    // Un adorno de pared se duplica en la pared, sin solaparse.
    const pic = placeNew(items, "cuadro", 3, 0, false, ctx);
    const dup = duplicateItem(pic.furniture, pic.id!, ctx);
    expect(dup.error).toBeUndefined();
    const copyPic = at(dup.furniture, dup.id!);
    expect(copyPic).toMatchObject({ kind: "cuadro", y: 0 });
    expect(copyPic.flip).toBeFalsy();
    expect(Math.abs(copyPic.x - 3)).toBe(1);
  });

  it("duplicar avisa si ya no cabe y placeNear busca el hueco más cercano", () => {
    // Un solo tramo de muro alto: el segundo cuadro no tiene dónde ir.
    const oneWall = { ...ctx, northWall: [true, ...new Array(9).fill(false)], westWall: new Array(10).fill(false) };
    const items = placeNew([], "cuadro", 0, 0, false, oneWall).furniture;
    expect(items).toHaveLength(1);
    expect(duplicateItem(items, items[0].id, oneWall).error).toMatch(/No queda sitio/);
    expect(duplicateItem(items, "nada", oneWall).error).toMatch(/ya no está/);
    const near = placeNear([], "planta", { x: 5, y: 5 }, false, ctx);
    expect(at(near.furniture, near.id!)).toMatchObject({ x: 5, y: 5 });
  });
});

describe("editor de sala: objetos encima", () => {
  function deskWithPc() {
    const desk = placeNew([], "escritorio", 2, 2, false, ctx);
    const pc = placeNew(desk.furniture, "ordenador", 3, 2, false, ctx);
    return { items: pc.furniture, deskId: desk.id!, pcId: pc.id!, error: pc.error };
  }

  it("van encima de una superficie, a su altura", () => {
    expect(placeNew([], "ordenador", 5, 5, false, ctx).error).toMatch(/encima/);
    const { items, pcId, error } = deskWithPc();
    expect(error).toBeUndefined();
    expect(at(items, pcId).z).toBe(17);
    expect(placeNew(items, "taza", 3, 2, false, ctx).error).toMatch(/ya está/);
  });

  it("al mover o girar la mesa, lo de encima viaja con ella", () => {
    const { items, deskId, pcId } = deskWithPc();
    const moved = moveItem(items, deskId, 5, 6, ctx);
    expect(moved.error).toBeUndefined();
    expect(at(moved.furniture, pcId)).toMatchObject({ x: 6, y: 6, z: 17 });
    const turned = rotateItem(moved.furniture, deskId, ctx);
    expect(turned.error).toBeUndefined();
    // Escritorio girado: ocupa (5,6) y (5,7); el ordenador pasa de (+1,0) a (0,+1).
    expect(at(turned.furniture, pcId)).toMatchObject({ x: 5, y: 7 });
    for (const it of turned.furniture) expect(checkItem(turned.furniture.filter((o) => o.id !== it.id), it, ctx)).toBeNull();
  });

  it("quitar la mesa quita lo que tiene encima", () => {
    const { items, deskId } = deskWithPc();
    expect(removeItem(items, deskId)).toEqual([]);
  });

  it("un movimiento imposible no cambia nada", () => {
    const { items, deskId } = deskWithPc();
    const r = moveItem(items, deskId, 9, 9, ctx);
    expect(r.error).toBeTruthy();
    expect(r.furniture).toBe(items);
  });
});

describe("editor de sala: avisos y recolocar", () => {
  it("avisa de puertas tapadas y asientos encerrados", () => {
    const door: FurnitureItem[] = [{ id: "a", kind: "planta", x: 4, y: 0 }];
    expect(layoutWarnings(door, ctx).join(" ")).toMatch(/puerta/);
    const boxed: FurnitureItem[] = [
      { id: "s", kind: "silla", x: 0, y: 0 },
      { id: "p1", kind: "planta", x: 1, y: 0 },
      { id: "p2", kind: "planta", x: 0, y: 1 },
    ];
    expect(layoutWarnings(boxed, ctx)).toEqual(["Nadie puede sentarse en: silla."]);
    // Un rincón libre encerrado por muebles.
    const corner: FurnitureItem[] = [
      { id: "p1", kind: "planta", x: 1, y: 0 },
      { id: "p2", kind: "planta", x: 0, y: 1 },
    ];
    expect(layoutWarnings(corner, ctx)).toEqual(["Hay rincones a los que no se puede llegar."]);
    expect(layoutWarnings([], ctx)).toEqual([]);
  });

  it("recolocar automáticamente conserva los muebles, los colores y vuelve a juntar los puestos", () => {
    const items: FurnitureItem[] = [
      { id: "1", kind: "silla", x: 8, y: 8, manual: true, tint: { $asiento: "#123456" } },
      { id: "2", kind: "planta", x: 7, y: 1, manual: true },
      { id: "3", kind: "escritorio", x: 1, y: 7, manual: true },
      { id: "4", kind: "cuadro", x: 2, y: 0, manual: true },
    ];
    const r = autoArrange(items, { ...ctx, seed: "s" });
    expect(r.skipped).toEqual([]);
    expect(r.furniture.map((f) => f.kind).sort()).toEqual(["cuadro", "escritorio", "planta", "silla"]);
    expect(r.furniture.every((f) => !f.manual)).toBe(true);
    const chair = r.furniture.find((f) => f.kind === "silla")!;
    const desk = r.furniture.find((f) => f.kind === "escritorio")!;
    expect(chair.tint).toEqual({ $asiento: "#123456" });
    expect(chair.x).toBe(desk.x - 1);
  });
});

describe("lo colocado a mano se respeta", () => {
  it("el decorador añade sin mover lo que ya hay", () => {
    const manual = placeNew(placeNew([], "sofa", 6, 6, false, ctx).furniture, "estanteria", 3, 4, false, ctx).furniture;
    const { furniture } = decorate(manual, ["planta", "sillon", "puesto", "cuadro"], { ...ctx, seed: "x" });
    for (const m of manual) expect(furniture.find((f) => f.id === m.id)).toEqual(m);
    expect(furniture.length).toBeGreaterThan(manual.length);
  });

  it("quitar por tipo prefiere lo que se colocó solo", () => {
    const items: FurnitureItem[] = [
      { id: "a", kind: "planta", x: 1, y: 1, manual: true },
      { id: "b", kind: "planta", x: 2, y: 1 },
    ];
    expect(removeKinds(items, ["planta"]).furniture.map((f) => f.id)).toEqual(["a"]);
  });
});

describe("guardar la distribución", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  it("persiste la distribución manual y las altas posteriores no la mueven", () => {
    const room = buildRoom({ name: "Biblioteca", domain: "Libros" });
    const layout = placeNew([], "sillon", 7, 7, false, ctx).furniture;
    setRoomLayout(room.id, layout);
    expect(getRoom(room.id)!.furniture).toEqual(layout);
    const r = redecorateRoom(room.id, { add: ["planta", "globo"] });
    expect(r.placed).toEqual(["planta", "globo"]);
    expect(r.room.furniture.find((f) => f.id === layout[0].id)).toEqual(layout[0]);
  });

  it("rechaza muebles desconocidos o fuera de la sala", () => {
    const room = listRooms()[0];
    expect(() => setRoomLayout(room.id, [{ id: "x", kind: "nave_espacial", x: 1, y: 1 }])).toThrow(/conozco/);
    expect(() => setRoomLayout(room.id, [{ id: "x", kind: "sofa", x: 9, y: 9 }])).toThrow(/sale/);
    expect(() =>
      setRoomLayout(room.id, [
        { id: "x", kind: "planta", x: 1, y: 1 },
        { id: "x", kind: "planta", x: 2, y: 1 },
      ]),
    ).toThrow(/id/);
  });
});
