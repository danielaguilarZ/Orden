import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief, getAgent, setAgentLocation } from "@/lib/repo/agents";
import { getRoom, listRooms } from "@/lib/repo/rooms";
import { hireAgent } from "@/lib/team";
import { createBlankRoom, purgeRoom, removeRoom, restoreRoom } from "@/lib/rooms";
import { roomFits } from "@/living/house";
import { checkRoomRemoval, joinNames } from "@/living/roomRemoval";
import type { Room } from "@/lib/types";

function room(id: string, x: number, y: number, extra: Partial<Room> = {}): Room {
  return {
    id,
    name: id,
    kind: "estudio",
    agentId: null,
    building: "orden",
    x,
    y,
    w: 10,
    d: 10,
    style: { floor: "madera", floorA: "#000", floorB: "#000", wall: "#000", wallTrim: "#000" },
    furniture: [],
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

const agent = (id: string, roomId: string | null, locationRoomId: string | null = null) => ({ id, name: id, roomId, locationRoomId });

describe("checkRoomRemoval (puro)", () => {
  it("no deja borrar la última sala de un edificio", () => {
    const a = room("A", 0, 0);
    const t = room("T", 16, 0, { building: "anexo" });
    expect(checkRoomRemoval(t, [a, t], []).blocked).toMatch(/última sala de anexo/);
    expect(checkRoomRemoval(a, [a, t], []).blocked).toMatch(/última sala de Oficina/);
  });

  it("no deja borrar la sala propia de un agente", () => {
    const a = room("A", 0, 0, { agentId: "zen" });
    const b = room("B", 10, 0);
    expect(checkRoomRemoval(a, [a, b], [agent("zen", "A")]).blocked).toMatch(/sala propia de zen/);
    // Si el dueño ya no existe, se trata como común.
    expect(checkRoomRemoval(a, [a, b], []).blocked).toBeNull();
  });

  it("no deja partir un edificio en dos (salas sin puerta para llegar)", () => {
    const rooms = [room("A", 0, 0), room("B", 10, 0), room("C", 20, 0)];
    expect(checkRoomRemoval(rooms[1], rooms, []).blocked).toMatch(/Separaría/);
    expect(checkRoomRemoval(rooms[2], rooms, []).blocked).toBeNull();
  });

  it("no deja un edificio sin pasarela", () => {
    const a = room("A", 0, 0);
    const t1 = room("T1", 16, 0, { building: "anexo" });
    const t2 = room("T2", 16, 10, { building: "anexo" });
    expect(checkRoomRemoval(t1, [a, t1, t2], []).blocked).toMatch(/pasarela/);
    expect(checkRoomRemoval(t2, [a, t1, t2], []).blocked).toBeNull();
  });

  it("separa a quien tiene aquí su escritorio (se reubica) de quien solo está de visita", () => {
    const rooms = [room("A", 0, 0), room("B", 10, 0)];
    const check = checkRoomRemoval(rooms[1], rooms, [agent("pol", "B"), agent("ana", "A", "B"), agent("leo", "A")]);
    expect(check.blocked).toBeNull();
    expect(check.relocate.map((a) => a.id)).toEqual(["pol"]);
    expect(check.visitors.map((a) => a.id)).toEqual(["ana"]);
  });

  it("une nombres en español", () => {
    expect(joinNames(["Ana"])).toBe("Ana");
    expect(joinNames(["Ana", "Leo"])).toBe("Ana y Leo");
    expect(joinNames(["Ana", "Leo", "Pol"])).toBe("Ana, Leo y Pol");
  });
});

describe("borrar salas (papelera)", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  it("una sala vacía va a la papelera y se recupera en su sitio", () => {
    const blank = createBlankRoom();
    const zen = getChief()!;
    setAgentLocation(zen.id, blank.id);
    const { room: archived, relocated } = removeRoom(blank.id);
    expect(relocated).toEqual([]);
    expect(archived.archivedAt).toBeTruthy();
    expect(listRooms().some((r) => r.id === blank.id)).toBe(false);
    expect(listRooms({ archived: true }).map((r) => r.id)).toEqual([blank.id]);
    expect(getRoom(blank.id)).toBeNull();
    // Quien estaba de visita vuelve a su sitio.
    expect(getAgent(zen.id)!.locationRoomId).toBeNull();
    // Borrar dos veces avisa.
    expect(() => removeRoom(blank.id)).toThrow(/papelera/);

    const back = restoreRoom(blank.id);
    expect([back.x, back.y]).toEqual([blank.x, blank.y]);
    expect(back.archivedAt).toBeUndefined();
    expect(listRooms({ archived: true })).toEqual([]);
  });

  it("no borra el despacho de Zen ni la última sala del edificio", () => {
    const zen = getChief()!;
    expect(listRooms()).toHaveLength(1);
    expect(() => removeRoom(zen.roomId!)).toThrow(/última sala/);
    const otra = createBlankRoom();
    expect(() => removeRoom(zen.roomId!)).toThrow(/sala propia de Zen/);
    expect(() => removeRoom(otra.id)).not.toThrow();
    expect(listRooms()).toHaveLength(1);
    expect(() => removeRoom(zen.roomId!)).toThrow();
  });

  it("los escritorios asignados solo se reubican si se confirma; la sala recuperada busca otro hueco si el suyo está ocupado", () => {
    const leo = hireAgent({ name: "Leo", specialty: "Libros y cursos" });
    const office = getRoom(leo.roomId!)!;
    expect(() => removeRoom(office.id)).toThrow(/escritorio Leo/);
    expect(getRoom(office.id)).not.toBeNull();

    const { relocated } = removeRoom(office.id, { relocate: true });
    const moved = getAgent(leo.id)!;
    expect(relocated).toEqual([{ agent: "Leo", room: getRoom(moved.roomId!)!.name }]);
    expect(moved.roomId).not.toBe(office.id);
    expect(getRoom(moved.roomId!)!.furniture.some((f) => f.id === moved.deskSeatId)).toBe(true);

    // La oficina nueva ocupó su hueco: al recuperarla va a otro libre.
    const back = restoreRoom(office.id);
    expect([back.x, back.y]).not.toEqual([office.x, office.y]);
    const others = listRooms().filter((r) => r.id !== back.id);
    expect(roomFits(others, back)).toBe(true);
    // Vuelve sin agentes: Leo sigue en su puesto nuevo.
    expect(getAgent(leo.id)!.roomId).toBe(moved.roomId);
  });

  it("solo se borran para siempre las salas de la papelera", () => {
    const blank = createBlankRoom();
    expect(() => purgeRoom(blank.id)).toThrow(/papelera/);
    removeRoom(blank.id);
    purgeRoom(blank.id);
    expect(getRoom(blank.id, { archived: true })).toBeNull();
    expect(() => restoreRoom(blank.id)).toThrow(/papelera/);
  });
});
