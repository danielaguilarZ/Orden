import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { decorate, doorTiles, removeKinds } from "@/living/decorator";
import { buildNavGrid, findPath, isFree } from "@/living/house";
import { FURNITURE, footprint } from "@/living/furniture";
import { pickRoomTemplate, ROOM_TEMPLATES } from "@/lib/roomTemplates";
import { listRooms } from "@/lib/repo/rooms";
import { hireAgent } from "@/lib/team";
import { buildRoom, createBlankRoom, redecorateRoom, uniqueRoomName } from "@/lib/rooms";
import type { Room } from "@/lib/types";

const open = (n = 10) => new Array(n).fill(true);
const ctx = (seed = "s") => ({ w: 10, d: 10, northWall: open(), westWall: open(), seed });

function asRoom(furniture: Room["furniture"]): Room {
  return {
    id: "r",
    name: "r",
    kind: "x",
    agentId: null,
    x: 0,
    y: 0,
    w: 10,
    d: 10,
    style: { floor: "madera", floorA: "#000", floorB: "#000", wall: "#000", wallTrim: "#000" },
    furniture,
    createdAt: "",
    updatedAt: "",
  };
}

describe("decorador automático", () => {
  it("todas las plantillas: puertas libres y se puede llegar a cada asiento", () => {
    for (const tpl of Object.values(ROOM_TEMPLATES).filter((t) => t.kinds)) {
      const { furniture } = decorate([], tpl.kinds!, ctx(tpl.kind));
      const g = buildNavGrid([asRoom(furniture)]);
      for (const [x, y] of doorTiles(10, 10)) expect(isFree(g, x, y), `${tpl.kind}: puerta ${x},${y}`).toBe(true);
      const [sx, sy] = doorTiles(10, 10)[0];
      for (const f of furniture.filter((f) => FURNITURE[f.kind].seat)) {
        expect(findPath(g, { x: sx, y: sy }, { x: f.x, y: f.y }), `${tpl.kind}: asiento ${f.kind}`).not.toBeNull();
      }
      // Todas las baldosas libres conectadas entre sí.
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (isFree(g, x, y)) expect(findPath(g, { x: sx, y: sy }, { x, y })).not.toBeNull();
    }
  });

  it("los muebles no se solapan y los altos van al fondo", () => {
    const { furniture } = decorate([], ["estanteria", "nevera", "archivador", "planta", "sillon"], ctx());
    const used = new Set<string>();
    for (const f of furniture) {
      const fp = footprint(f.kind, f.flip);
      for (let dy = 0; dy < fp.d; dy++)
        for (let dx = 0; dx < fp.w; dx++) {
          const k = `${f.x + dx},${f.y + dy}`;
          expect(used.has(k)).toBe(false);
          used.add(k);
        }
      if (FURNITURE[f.kind].tall) expect(f.x === 0 || f.y === 0).toBe(true);
    }
  });

  it("«puesto» = silla + escritorio, y los objetos pequeños van encima", () => {
    const { furniture } = decorate([], ["puesto", "ordenador", "calculadora"], ctx());
    const desk = furniture.find((f) => f.kind === "escritorio")!;
    const chair = furniture.find((f) => f.kind === "silla")!;
    expect(chair.x).toBe(desk.x - 1);
    const tops = furniture.filter((f) => FURNITURE[f.kind].onTop);
    expect(tops).toHaveLength(2);
    for (const t of tops) expect(t.z).toBe(17);
  });

  it("sin muros altos no cuelga adornos; y es determinista por semilla", () => {
    const noWalls = { ...ctx(), northWall: new Array(10).fill(false), westWall: new Array(10).fill(false) };
    expect(decorate([], ["ventana", "cuadro"], noWalls).skipped).toEqual(["ventana", "cuadro"]);
    const a = decorate([], ["planta", "sillon", "lampara"], ctx("x")).furniture.map((f) => [f.kind, f.x, f.y]);
    const b = decorate([], ["planta", "sillon", "lampara"], ctx("x")).furniture.map((f) => [f.kind, f.x, f.y]);
    expect(a).toEqual(b);
  });

  it("quitar muebles por tipo", () => {
    const { furniture } = decorate([], ["planta", "planta", "sillon"], ctx());
    const r = removeKinds(furniture, ["planta", "tele"]);
    expect(r.removed).toEqual(["planta"]);
    expect(r.furniture.filter((f) => f.kind === "planta")).toHaveLength(1);
  });
});

describe("salas por ámbito", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  it("la casa empieza solo con el despacho de Zen", () => {
    const rooms = listRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ kind: "despacho_zen", name: "Despacho de Zen", building: "orden" });
  });

  it("elige la plantilla por palabras clave (sin tildes)", () => {
    expect(pickRoomTemplate("Recetas y menú semanal").kind).toBe("cocina");
    expect(pickRoomTemplate("Salud, ejercicio y sueño").kind).toBe("salud");
    expect(pickRoomTemplate("Trámites y papeleo con Hacienda").kind).toBe("tramites");
    expect(pickRoomTemplate("Aprender inglés").kind).toBe("biblioteca");
    expect(pickRoomTemplate("cosas varias").kind).toBe("estudio");
  });

  it("contratar abre la oficina compartida (amueblada) en el siguiente hueco; un ámbito sin agente también", () => {
    const leo = hireAgent({ name: "Leo", specialty: "Libros y cursos" });
    const room = listRooms().find((r) => r.id === leo.roomId)!;
    expect(room).toMatchObject({ kind: "oficina", name: "Oficina compartida", agentId: null });
    expect(room.furniture.length).toBeGreaterThan(5);
    expect([room.x, room.y]).toEqual([10, 0]);
    const viajes = buildRoom({ name: "Viajes", domain: "vacaciones y viajes" });
    expect(viajes.kind).toBe("viajes");
    expect([viajes.x, viajes.y]).toEqual([0, 10]);
  });

  it("la oficina compartida no la elige un ámbito cualquiera", () => {
    expect(pickRoomTemplate("Libros y cursos").kind).toBe("biblioteca");
    expect(pickRoomTemplate("cosas varias").kind).toBe("estudio");
    expect(pickRoomTemplate("oficina compartida").kind).toBe("oficina");
  });

  it("sala vacía desde el editor: común, sin muebles, nombre libre y en el hueco de su edificio", () => {
    const a = createBlankRoom();
    expect(a).toMatchObject({ name: "Sala nueva", kind: "estudio", agentId: null, building: "orden", furniture: [] });
    const b = createBlankRoom({ building: "orden" });
    expect(b.name).toBe("Sala nueva 2");
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
    expect(createBlankRoom({ name: "  Taller  " }).name).toBe("Taller");
    // Edificio desconocido: a la casa.
    expect(createBlankRoom({ building: "marte" }).building).toBe("orden");
  });

  it("un segundo edificio va aparte y nunca se solapa con la casa", () => {
    const anexo = buildRoom({ name: "Anexo", domain: "estudio", building: "anexo", empty: true });
    expect(anexo).toMatchObject({ building: "anexo", agentId: null, furniture: [] });
    const all = listRooms();
    for (const o of all.filter((o) => o.id !== anexo.id)) expect(o.x === anexo.x && o.y === anexo.y).toBe(false);
    const r = redecorateRoom(anexo.id, { add: ["sillon"] });
    expect(r.placed).toEqual(["sillon"]);
  });

  it("nombres libres sin distinguir mayúsculas", () => {
    expect(uniqueRoomName("Sala nueva", [{ name: "sala nueva" }, { name: "Sala nueva 2" }])).toBe("Sala nueva 3");
    expect(uniqueRoomName("Sala nueva", [])).toBe("Sala nueva");
  });

  it("redecorar añade donde cabe y quita", () => {
    const before = buildRoom({ name: "Biblioteca", domain: "Libros" });
    const r = redecorateRoom(before.id, { add: ["globo"], remove: ["planta"] });
    expect(r.placed).toEqual(["globo"]);
    expect(r.removed).toEqual(["planta"]);
  });
});
