import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrations } from "@/lib/db/migrations";
import { setDbForTests } from "@/lib/db";
import { listRooms } from "@/lib/repo/rooms";
import { buildNavGrid, computeDoors, findPath, LEVEL_STRIDE, levelOf } from "@/living/house";
import { initialLevel, levelAtX, levelOffset, levelScreenBounds, projectOnLevel, STOREY_H, towerFootprint, towerLevels } from "@/living/floors";
import { CLEAR_H, GLASS_H, shellEdges, towerShell } from "@/living/towerRender";
import { FLOOR_T, T, WALL_H } from "@/living/houseRender";
import { project } from "@/living/raster";
import type { Room } from "@/lib/types";

function room(id: string, level: number, lx: number, ly: number): Room {
  return {
    id,
    name: id,
    kind: "x",
    agentId: null,
    building: "orden",
    level,
    x: level * LEVEL_STRIDE + lx,
    y: ly,
    w: 10,
    d: 10,
    style: { floor: "madera", floorA: "#000", floorB: "#000", wall: "#000", wallTrim: "#000" },
    furniture: [],
    createdAt: "",
    updatedAt: "",
  };
}

describe("dibujo apilado (puro)", () => {
  it("un piso mide lo que el muro más el forjado", () => {
    expect(STOREY_H).toBe(WALL_H + FLOOR_T);
    expect(CLEAR_H).toBeLessThan(STOREY_H);
    expect(GLASS_H).toBeLessThan(CLEAR_H);
  });

  it("cada planta se dibuja exactamente encima de la baja, subida un piso por planta", () => {
    for (const level of [0, 1, 2, 5]) {
      for (const [lx, ly, z] of [
        [0, 0, 0],
        [3.5, 7, 12],
        [30, 20, 62],
      ]) {
        const up = projectOnLevel((level * LEVEL_STRIDE + lx) * T, ly * T, z, level);
        const ground = project(lx * T, ly * T, z);
        expect(up.sx).toBeCloseTo(ground.sx, 6);
        expect(up.sy).toBeCloseTo(ground.sy - level * STOREY_H, 6);
      }
    }
    expect(levelOffset(0).x + 0).toBe(0);
    expect(levelOffset(0).y + 0).toBe(0);
  });

  it("la huella de la torre une las salas de todas las plantas en coordenadas locales", () => {
    const rooms = [room("a", 1, 0, 0), room("b", 1, 10, 0), room("c", 2, 0, 0), room("d", 2, 20, 10)];
    expect(towerFootprint(rooms)).toEqual({ x0: 0, y0: 0, x1: 30, y1: 20 });
    expect(towerFootprint([])).toBeNull();
    // Se dibujan todas desde la baja (aunque esté vacía) hasta la más alta.
    expect(towerLevels(rooms)).toEqual([0, 1, 2]);
    expect(levelAtX(LEVEL_STRIDE * 2 + 15)).toBe(2);
  });

  it("los rectángulos en pantalla de las plantas se apilan sin huecos, un piso cada uno", () => {
    const fp = { x0: 0, y0: 0, x1: 30, y1: 20 };
    const b0 = levelScreenBounds(fp, 0);
    const b1 = levelScreenBounds(fp, 1);
    expect(b1.x).toBe(b0.x);
    expect(b1.width).toBe(b0.width);
    expect(b0.y - b1.y).toBe(STOREY_H);
    // El de arriba llega al de abajo (se solapan: el forjado de arriba tapa el canto del muro).
    expect(b1.y + b1.height).toBeGreaterThanOrEqual(b0.y);
  });

  it("envolvente: forjado bajo toda la huella, muro cortina delante y cristal detrás solo donde no hay muro", () => {
    const fp = { x0: 0, y0: 0, x1: 30, y1: 20 };
    const mine = [room("a", 1, 0, 0), room("b", 1, 10, 0)];
    const shell = towerShell(fp, 1, mine);
    const e = shellEdges(fp, 1);
    const slab = shell.slab[0];
    expect(slab.x).toBeLessThanOrEqual(e.X0);
    expect(slab.x + slab.w).toBeGreaterThanOrEqual(e.X1);
    expect(slab.z + slab.h).toBeLessThan(0); // por debajo del suelo de las salas
    // Delante: un paño por baldosa en el sur (30) y en el este (20).
    expect(shell.frontGlass).toHaveLength(30 + 20);
    for (const g of shell.frontGlass) expect(g.z + g.h).toBeLessThanOrEqual(CLEAR_H);
    // Detrás: el norte tiene muro de sala en x 0–19 (cristal en 20–29) y el oeste en y 0–9 (cristal en 10–19).
    expect(shell.backGlass).toHaveLength(10 + 10);
    // La planta baja lleva además la plaza.
    expect(towerShell(fp, 0, []).slab).toHaveLength(2);
    expect(towerShell(fp, 0, []).backGlass).toHaveLength(30 + 20);
  });

  it("al abrir se ve la planta con más agentes trabajando; si no, la más alta", () => {
    const rooms = [room("t", 1, 0, 0), room("m", 2, 0, 0)];
    const agent = (roomId: string, status: "working" | "idle") => ({ status, paused: false, roomId, locationRoomId: null });
    expect(initialLevel(rooms, [agent("t", "idle"), agent("m", "idle")])).toBe(2);
    expect(initialLevel(rooms, [agent("t", "working"), agent("t", "working"), agent("m", "working")])).toBe(1);
    expect(initialLevel([], [])).toBe(0);
  });
});

describe("migración a plantas", () => {
  it("pasa la oficina principal a la planta 1 y marketing a la 2 sin perder muebles, puertas ni escritorios", () => {
    const db = new DatabaseSync(":memory:");
    for (const m of migrations.filter((m) => m.version <= 16)) m.up(db);
    db.exec("PRAGMA user_version = 16");
    const insert = db.prepare(
      `INSERT INTO rooms (id, name, kind, agent_id, building, x, y, w, d, style, furniture, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 10, 10, '{}', ?, ?, ?, ?)`,
    );
    const furn = (id: string) => JSON.stringify([{ id, kind: "silla", x: 2, y: 2 }]);
    let t = 0;
    const add = (id: string, building: string, x: number, y: number, archived: string | null = null) =>
      insert.run(id, id, "estudio", building, x, y, furn(`f-${id}`), archived, `2026-01-01T00:00:0${t}Z`, `2026-01-01T00:00:0${t++}Z`);
    // Como estaba: la oficina principal en el suelo y marketing «arriba» en diagonal (migración 16).
    add("zen", "orden", 0, 0);
    add("oficina", "orden", 10, 0);
    add("recepcion", "marketing", -28, -28);
    add("diego", "marketing", -18, -28);
    add("lucia", "marketing", -28, -18);
    add("vieja", "orden", 0, 10, "2026-01-02T00:00:00Z");
    db.prepare("INSERT INTO agents (id, name, room_id, desk_seat_id, created_at, updated_at) VALUES ('ag', 'Ana', 'oficina', 'f-oficina', 'x', 'x')").run();

    migrations.find((m) => m.version === 17)!.up(db);

    const rows = db.prepare("SELECT id, level, x, y, furniture FROM rooms ORDER BY created_at").all() as { id: string; level: number; x: number; y: number; furniture: string }[];
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect([by.zen.level, by.zen.x, by.zen.y]).toEqual([1, LEVEL_STRIDE, 0]);
    expect([by.oficina.level, by.oficina.x, by.oficina.y]).toEqual([1, LEVEL_STRIDE + 10, 0]);
    expect([by.recepcion.level, by.recepcion.x, by.recepcion.y]).toEqual([2, 2 * LEVEL_STRIDE, 0]);
    expect([by.diego.x, by.diego.y]).toEqual([2 * LEVEL_STRIDE + 10, 0]);
    expect([by.lucia.x, by.lucia.y]).toEqual([2 * LEVEL_STRIDE, 10]);
    // La de la papelera viaja con su zona.
    expect([by.vieja.level, by.vieja.x, by.vieja.y]).toEqual([1, LEVEL_STRIDE, 10]);
    // Muebles intactos y el escritorio asignado sigue apuntando a la misma silla.
    for (const r of rows) expect(JSON.parse(r.furniture)).toEqual([{ id: `f-${r.id}`, kind: "silla", x: 2, y: 2 }]);
    expect(db.prepare("SELECT room_id, desk_seat_id FROM agents WHERE id = 'ag'").get()).toEqual({ room_id: "oficina", desk_seat_id: "f-oficina" });

    // Las mismas puertas que antes (la distribución se traslada entera).
    setDbForTests(db as never);
    const rooms = listRooms();
    expect(rooms.map(levelOf).sort()).toEqual([1, 1, 2, 2, 2]);
    const doors = computeDoors(rooms).map((d) => d.rooms.slice().sort().join("|")).sort();
    expect(doors).toEqual(["diego|recepcion", "lucia|recepcion", "oficina|zen"]);
    expect(findPath(buildNavGrid(rooms), { x: LEVEL_STRIDE + 1, y: 1 }, { x: LEVEL_STRIDE + 15, y: 8 })).not.toBeNull();
  });
});
