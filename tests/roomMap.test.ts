import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { getRoom, listRooms } from "@/lib/repo/rooms";
import { createTask } from "@/lib/repo/tasks";
import { buildRoom, createBlankRoom, describeRooms, moveFurniture, placeFurnitureAt, redecorateRoom } from "@/lib/rooms";
import { buildTools } from "@/lib/agents/tools";
import { roomContext } from "@/living/roomEditor";
import { coherenceWarnings, findItemRef, freeZones, renderRoomMap, roomOpenings, seatFacing, shortIds, spotsNear } from "@/living/roomMap";
import type { Agent, FurnitureItem } from "@/lib/types";
import "@/lib/agents/modules";

const open = (n = 10) => new Array(n).fill(true);
const ctx = { w: 10, d: 10, northWall: open(), westWall: open() };

describe("plano de sala (puro)", () => {
  it("ids cortos únicos y búsqueda por id completo o corto", () => {
    const items: FurnitureItem[] = [
      { id: "aaaa-1234", kind: "planta", x: 1, y: 1 },
      { id: "bbbb-1234", kind: "planta", x: 2, y: 1 },
      { id: "cccc-9999", kind: "planta", x: 3, y: 1 },
    ];
    const ids = shortIds(items);
    expect(new Set(ids.values()).size).toBe(3);
    expect(ids.get("cccc-9999")).toBe("9999");
    expect(findItemRef(items, "9999").item?.id).toBe("cccc-9999");
    expect(findItemRef(items, "[9999]").item?.id).toBe("cccc-9999");
    expect(findItemRef(items, ids.get("aaaa-1234")!).item?.id).toBe("aaaa-1234");
    expect(findItemRef(items, "1234").error).toMatch(/ambiguo/);
    expect(findItemRef(items, "zzzz").error).toMatch(/No hay/);
  });

  it("mapa ASCII: muebles con letra, adornos en el muro, pasos de puerta y puertas reales", () => {
    const items: FurnitureItem[] = [
      { id: "s", kind: "silla", x: 2, y: 2 },
      { id: "e", kind: "escritorio", x: 3, y: 2, flip: true },
      { id: "o", kind: "ordenador", x: 3, y: 2, z: 17 },
      { id: "v", kind: "ventana", x: 1, y: 0 },
      { id: "a", kind: "alfombra", x: 6, y: 6 },
    ];
    const noWestHigh = { ...ctx, westWall: new Array(10).fill(false) };
    const { lines, marks } = renderRoomMap({ w: 10, d: 10 }, items, noWestHigh, [{ side: "este", from: 4, to: 6, toRoom: "Salón", walkway: false }]);
    expect(lines).toHaveLength(13);
    expect(lines[0].trim()).toBe("0 1 2 3 4 5 6 7 8 9");
    expect(marks.get("s")).toBe("A");
    expect(marks.get("e")).toBe("B");
    expect(marks.has("o")).toBe(false); // lo de encima no tiene letra
    expect(lines[1]).toBe("  + # a a # # # # # # # +");
    expect(lines[2]).toBe("0 - . . . . : : . . . . -");
    expect(lines[4]).toBe("2 - . . A B . . . . . . -");
    expect(lines[5]).toBe("3 - . . . B . . . . . . -");
    expect(lines[6]).toBe("4 - : . . . . . . . . : =");
    expect(lines[8]).toBe("6 - . . . . . . ~ ~ ~ . -");
  });

  it("asientos: miran a +x sin girar y a +y girados", () => {
    expect(seatFacing({ kind: "silla" })).toBe("+x");
    expect(seatFacing({ kind: "silla", flip: true })).toBe("+y");
    expect(seatFacing({ kind: "planta" })).toBeNull();
  });

  it("huecos libres: el mayor rectángulo sin muebles ni pasos de puerta", () => {
    expect(freeZones([], ctx)[0]).toEqual({ x: 1, y: 1, w: 8, d: 8 });
    const zones = freeZones([{ id: "x", kind: "sofa", x: 1, y: 1 }], ctx);
    for (const z of zones) expect(z.x <= 1 && z.x + z.w > 1 && z.y <= 2 && z.y + z.d > 1).toBe(false);
  });

  it("avisos de coherencia: silla sin mesa, de espaldas, escritorio sin silla y objetos flotando", () => {
    const lonely: FurnitureItem[] = [{ id: "s", kind: "silla", x: 7, y: 7 }];
    expect(coherenceWarnings(lonely, ctx).join(" ")).toMatch(/no tiene ninguna mesa delante/);
    const backwards: FurnitureItem[] = [
      { id: "e", kind: "escritorio", x: 2, y: 2, flip: true },
      { id: "s", kind: "silla", x: 3, y: 2 },
    ];
    const w = coherenceWarnings(backwards, ctx).join(" ");
    expect(w).toMatch(/no mira hacia ella/);
    expect(w).toMatch(/Escritorio .* no tiene ninguna silla delante/);
    const good: FurnitureItem[] = [
      { id: "s", kind: "silla", x: 2, y: 2 },
      { id: "e", kind: "escritorio", x: 3, y: 2, flip: true },
    ];
    expect(coherenceWarnings(good, ctx)).toEqual([]);
    expect(coherenceWarnings([{ id: "o", kind: "ordenador", x: 5, y: 5 }], ctx).join(" ")).toMatch(/flotando/);
  });

  it("junto a: la silla mira a la mesa y lo pequeño va encima", () => {
    const desk: FurnitureItem = { id: "e", kind: "escritorio", x: 4, y: 3 };
    const chair = spotsNear("silla", desk, ctx);
    expect(chair[0]).toEqual({ x: 3, y: 3, flip: false });
    expect(chair).toContainEqual({ x: 4, y: 2, flip: true });
    expect(spotsNear("ordenador", desk, ctx)).toEqual([
      { x: 4, y: 3, flip: false },
      { x: 5, y: 3, flip: false },
    ]);
    const seat: FurnitureItem = { id: "s", kind: "silla", x: 2, y: 6 };
    expect(spotsNear("escritorio", seat, ctx)[0]).toEqual({ x: 3, y: 6, flip: true });
  });
});

describe("plano de sala (con la casa)", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  function toolsFor(agent: Agent) {
    const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
    const tools = buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
    return async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`Falta la herramienta ${name}`);
      const r = (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0].text, isError: Boolean(r.isError) };
    };
  }

  it("puertas reales entre salas; entre plantas no hay pasarela (se va en ascensor)", () => {
    createBlankRoom({ name: "Taller" });
    // Una zona sin planta propia va a la planta baja: otra planta, sin pasarela.
    buildRoom({ name: "Anexo", domain: "estudio", building: "anexo", empty: true });
    const rooms = listRooms();
    const all = rooms.flatMap((r) => roomOpenings(r, rooms).map((o) => ({ room: r.name, ...o })));
    expect(all.some((o) => !o.walkway)).toBe(true);
    expect(all.filter((o) => o.walkway)).toHaveLength(0);
  });

  it("dos zonas en la misma planta sí se unen con una pasarela", () => {
    const rooms = [
      { ...listRooms()[0], id: "a", building: "orden", level: 0, x: 0, y: 0 },
      { ...listRooms()[0], id: "b", building: "anexo", level: 0, x: 16, y: 0 },
    ];
    const bridge = rooms.flatMap((r) => roomOpenings(r, rooms)).filter((o) => o.walkway);
    expect(bridge).toHaveLength(2);
    expect(new Set(bridge.map((b) => b.side))).toEqual(new Set(["este", "oeste"]));
  });

  it("colocar en una posición: exacta, con colores de la sala, y error claro si choca", () => {
    const room = createBlankRoom({ name: "Taller" });
    const a = placeFurnitureAt(room.id, "sofa", { x: 2, y: 2 });
    expect(a.items[0]).toMatchObject({ kind: "sofa", x: 2, y: 2 });
    const before = getRoom(room.id)!.furniture;
    expect(() => placeFurnitureAt(room.id, "planta", { x: 2, y: 3 })).toThrow(/Choca con Sofá \[\w+\] en \(2,2\).*Posiciones válidas cercanas/);
    expect(() => placeFurnitureAt(room.id, "planta", { x: 4, y: 0 })).toThrow(/puerta/);
    expect(getRoom(room.id)!.furniture).toEqual(before);
    // Puesto: silla en (x,y) y escritorio delante; girado, debajo.
    const p = placeFurnitureAt(room.id, "puesto", { x: 6, y: 2 });
    expect(p.items.map((i) => [i.kind, i.x, i.y, Boolean(i.flip)])).toEqual([
      ["silla", 6, 2, false],
      ["escritorio", 7, 2, true],
    ]);
    expect(p.warnings).toEqual([]);
    const g = placeFurnitureAt(room.id, "puesto", { x: 2, y: 6, flip: true });
    expect(g.items.map((i) => [i.x, i.y, Boolean(i.flip)])).toEqual([
      [2, 6, true],
      [2, 7, false],
    ]);
    expect(g.warnings).toEqual([]);
  });

  it("mover: a una posición, girar, junto a una mesa, y lo de encima viaja con la mesa", () => {
    const room = createBlankRoom({ name: "Taller" });
    const desk = placeFurnitureAt(room.id, "escritorio", { x: 5, y: 6 }).items[0];
    const pc = placeFurnitureAt(room.id, "ordenador", { near: desk.id }).items[0];
    expect(pc).toMatchObject({ x: 5, y: 6, z: 17 });
    const chair = placeFurnitureAt(room.id, "silla", { x: 8, y: 1 }).items[0];
    expect(placeFurnitureAt(room.id, "planta", { x: 1, y: 7 }).warnings.join(" ")).toMatch(/no tiene ninguna mesa delante/);

    const r = moveFurniture(room.id, chair.id.slice(-4), { near: desk.id });
    expect(r.items[0]).toMatchObject({ x: 4, y: 6 });
    expect(r.warnings.join(" ")).not.toMatch(/Silla.*mesa delante|Escritorio.*silla delante/);

    const moved = moveFurniture(room.id, desk.id, { x: 6, y: 2 });
    expect(moved.items[0]).toMatchObject({ x: 6, y: 2 });
    expect(getRoom(room.id)!.furniture.find((f) => f.id === pc.id)).toMatchObject({ x: 6, y: 2 });

    const turned = moveFurniture(room.id, desk.id, { flip: true });
    expect(turned.items[0]).toMatchObject({ x: 6, y: 2, flip: true });
    expect(() => moveFurniture(room.id, desk.id, { x: 9, y: 9 })).toThrow(/No se puede mover Escritorio/);
    expect(() => moveFurniture(room.id, "nada", { x: 1, y: 1 })).toThrow(/No hay ningún mueble/);
  });

  it("adornos de pared: la posición decide el muro", () => {
    const room = createBlankRoom({ name: "Galería" });
    const wc = roomContext(room, listRooms());
    const nx = wc.northWall.findIndex((ok, i) => ok && i > 0);
    const wy = wc.westWall.findIndex((ok, i) => ok && i > 0);
    if (nx < 0 || wy < 0) return; // sin muros altos en esta posición de la casa
    const pic = placeFurnitureAt(room.id, "cuadro", { x: nx, y: 0 }).items[0];
    expect(pic.flip).toBeFalsy();
    const r = moveFurniture(room.id, pic.id, { x: 0, y: wy });
    expect(r.items[0]).toMatchObject({ x: 0, y: wy, flip: true });
  });

  it("quitar un mueble concreto por id", () => {
    const room = createBlankRoom({ name: "Taller" });
    const a = placeFurnitureAt(room.id, "planta", { x: 1, y: 1 }).items[0];
    const b = placeFurnitureAt(room.id, "planta", { x: 2, y: 1 }).items[0];
    const r = redecorateRoom(room.id, { remove: [b.id.slice(-4)] });
    expect(r.room.furniture.map((f) => f.id)).toEqual([a.id]);
    expect(r.removed[0]).toMatch(/Planta/);
  });

  it("herramientas: sala_ver, sala_decorar con posición y sala_mover_mueble", async () => {
    const call = toolsFor(getChief()!);
    const zenRoom = getRoom(getChief()!.roomId!)!;
    const view = await call("sala_ver", { sala: zenRoom.name });
    expect(view.isError).toBe(false);
    expect(view.text).toMatch(/Plano:/);
    expect(view.text).toMatch(/Bonsái [A-Z0-9] \[\w+\]: \(\d,\d\)/);
    expect(view.text).toMatch(/Huecos más grandes|Suelo libre/);

    const room = createBlankRoom({ name: "Estudio vacío" });
    const put = await call("sala_decorar", { sala: room.name, anadir: ["escritorio"], x: 5, y: 5 });
    expect(put.isError).toBe(false);
    expect(put.text).toMatch(/Colocado: Escritorio \[\w+\] en \(5,5\)/);
    const desk = getRoom(room.id)!.furniture[0];
    const sofa = await call("sala_decorar", { sala: room.name, anadir: ["sofa"], x: 1, y: 7 });
    expect(sofa.isError).toBe(false);
    const seat = await call("sala_decorar", { sala: room.name, anadir: ["silla"], junto_a: desk.id.slice(-4) });
    expect(seat.text).toMatch(/en \(4,5\)/);
    expect(seat.text).toMatch(/Sin avisos/);

    expect((await call("sala_decorar", { sala: room.name, anadir: ["planta", "sofa"], x: 1, y: 1 })).isError).toBe(true);
    const bad = await call("sala_mover_mueble", { sala: room.name, mueble: desk.id, x: 4, y: 5 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Choca con Silla/);
    const okMove = await call("sala_mover_mueble", { sala: room.name, mueble: desk.id, x: 6, y: 7 });
    expect(okMove.isError).toBe(false);
    expect(okMove.text).toMatch(/no tiene ninguna/);
  });

  it("el contexto da el tamaño de cada sala y explica sala_ver", () => {
    const chief = getChief()!;
    expect(describeRooms(listRooms(), [chief], chief)).toMatch(/· 10×10 · muebles:/);
  });
});
