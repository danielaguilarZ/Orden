import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getAgent, getChief } from "@/lib/repo/agents";
import { deleteRoom, getRoom, listRooms } from "@/lib/repo/rooms";
import { createTask } from "@/lib/repo/tasks";
import { buildRoom } from "@/lib/rooms";
import { editAgent, fireAgent, hireAgent } from "@/lib/team";
import { buildTools } from "@/lib/agents/tools";
import { buildContext, buildSystemPrompt } from "@/lib/agents/prompt";
import { currentRoom, deskSeats, findRoomByRef, freeDeskSeat, furnitureSummary, pickSeat, roomRelation } from "@/living/presence";
import type { Agent, Room } from "@/lib/types";
import "@/lib/agents/modules";

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

function toolsFor(agent: Agent) {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  const notes: string[] = [];
  const tools = buildTools({ agent, task, signal: new AbortController().signal, note: (t) => notes.push(t) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`Falta la herramienta ${name}`);
    return (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
  };
  return { tools, call, notes };
}

const room = (id: string, name = id): Room => ({
  id,
  name,
  kind: "x",
  agentId: null,
  x: 0,
  y: 0,
  w: 10,
  d: 10,
  style: { floor: "madera", floorA: "#000", floorB: "#000", wall: "#000", wallTrim: "#000" },
  furniture: [],
  createdAt: "",
  updatedAt: "",
});

describe("presencia (puro)", () => {
  const rooms = [room("a", "Salón"), room("b", "Despacho de Gwen"), room("c", "Cocina")];

  it("sala actual: a la que se ha ido, si no la suya y si no la primera", () => {
    expect(currentRoom({ roomId: "b", locationRoomId: "c" }, rooms)?.id).toBe("c");
    expect(currentRoom({ roomId: "b", locationRoomId: null }, rooms)?.id).toBe("b");
    expect(currentRoom({ roomId: "b", locationRoomId: "borrada" }, rooms)?.id).toBe("b");
    expect(currentRoom({ roomId: null, locationRoomId: null }, rooms)?.id).toBe("a");
  });

  it("busca salas por id o nombre, exacto y parcial, sin mayúsculas", () => {
    expect(findRoomByRef(rooms, "c")?.id).toBe("c");
    expect(findRoomByRef(rooms, "cocina")?.id).toBe("c");
    expect(findRoomByRef(rooms, "gwen")?.id).toBe("b");
    expect(findRoomByRef(rooms, "  ")).toBeUndefined();
  });

  it("resume muebles agrupados", () => {
    expect(furnitureSummary([])).toBe("");
    expect(furnitureSummary([{ id: "1", kind: "silla", x: 0, y: 0 }, { id: "2", kind: "silla", x: 1, y: 0 }, { id: "3", kind: "planta", x: 2, y: 0 }])).toBe(
      "Silla ×2 · Planta",
    );
  });

  it("asiento: solo en la sala indicada, libre y con preferencia", () => {
    const seats = [
      { id: "1", roomId: "a", bed: false, nearDesk: true },
      { id: "2", roomId: "c", bed: false, nearDesk: false },
      { id: "3", roomId: "c", bed: true, nearDesk: false },
      { id: "4", roomId: "c", bed: false, nearDesk: true },
    ];
    expect(pickSeat(seats, "c", () => false, false)?.id).toBe("4");
    expect(pickSeat(seats, "c", (s) => s.id === "4", false)?.id).toBe("2");
    expect(pickSeat(seats, "c", () => false, true)?.id).toBe("3");
    expect(pickSeat(seats, "b", () => false, false)).toBeUndefined();
  });

  it("asiento: cada uno a su escritorio; los asignados a otros, solo si no queda otro", () => {
    const seats = [
      { id: "s1", roomId: "o", bed: false, nearDesk: true },
      { id: "s2", roomId: "o", bed: false, nearDesk: true },
      { id: "s3", roomId: "o", bed: false, nearDesk: true },
    ];
    const reserved = (s: { id: string }) => s.id === "s1" || s.id === "s3";
    expect(pickSeat(seats, "o", () => false, false, { own: "s3", reserved })?.id).toBe("s3");
    expect(pickSeat(seats, "o", () => false, false, { reserved })?.id).toBe("s2");
    expect(pickSeat(seats, "o", (s) => s.id === "s2", false, { reserved })?.id).toBe("s1");
    // Si su silla está ocupada, se sienta en otra libre.
    expect(pickSeat(seats, "o", (s) => s.id === "s3", false, { own: "s3", reserved })?.id).toBe("s2");
  });

  it("sillas de puesto: asientos junto a un escritorio, libres si nadie las tiene asignadas", () => {
    const furniture = [
      { id: "c1", kind: "silla", x: 3, y: 2 },
      { id: "d1", kind: "escritorio", x: 4, y: 2, flip: true },
      { id: "c2", kind: "silla", x: 3, y: 6 },
      { id: "d2", kind: "escritorio", x: 4, y: 6, flip: true },
      { id: "so", kind: "sillon", x: 8, y: 9 },
    ];
    expect(deskSeats(furniture).map((f) => f.id)).toEqual(["c1", "c2"]);
    expect(freeDeskSeat({ furniture }, [{ deskSeatId: "c1" }])?.id).toBe("c2");
    expect(freeDeskSeat({ furniture }, [{ deskSeatId: "c1" }, { deskSeatId: "c2" }])).toBeUndefined();
  });

  it("relación con la sala: la propia o la de su escritorio", () => {
    const own = { ...room("p"), agentId: "ag" };
    const office = room("o");
    expect(roomRelation(own, { id: "ag", roomId: "p" })).toBe("propia");
    expect(roomRelation(office, { id: "ag", roomId: "o" })).toBe("escritorio");
    expect(roomRelation(office, { id: "ag", roomId: "p" })).toBeNull();
  });
});

describe("escritorio asignado al contratar", () => {
  it("sin sala propia: escritorio libre en la oficina compartida, que se crea una sola vez", () => {
    const before = listRooms().length;
    const a = hireAgent({ name: "Ana", specialty: "finanzas" });
    const b = hireAgent({ name: "Bea", specialty: "cocina" });
    expect(listRooms()).toHaveLength(before + 1);
    expect(a.roomId).toBe(b.roomId);
    expect(a.deskSeatId).not.toBe(b.deskSeatId);
    const office = getRoom(a.roomId!)!;
    expect(office).toMatchObject({ kind: "oficina", agentId: null, building: "orden" });
    expect(listRooms().some((r) => r.agentId === a.id || r.agentId === b.id)).toBe(false);
    // Aparece directamente en su sala de escritorio.
    expect(currentRoom(getAgent(a.id)!, listRooms())?.id).toBe(office.id);
  });

  it("si no hay hueco añade un puesto sin mover los demás; al irse, su escritorio se reutiliza", () => {
    const names = ["Ana", "Bea", "Carla", "Dani"];
    const hired = names.map((n) => hireAgent({ name: n, specialty: "varios" }));
    const office = getRoom(hired[0].roomId!)!;
    const seats = deskSeats(office.furniture);
    expect(seats).toHaveLength(4);
    const quinto = hireAgent({ name: "Eva", specialty: "varios" });
    const after = getRoom(office.id)!;
    expect(quinto.roomId).toBe(office.id);
    expect(deskSeats(after.furniture)).toHaveLength(5);
    for (const f of office.furniture) expect(after.furniture.find((g) => g.id === f.id)).toEqual(f);
    fireAgent(hired[1].id);
    const sexto = hireAgent({ name: "Fran", specialty: "varios" });
    expect(sexto.deskSeatId).toBe(hired[1].deskSeatId);
    expect(getRoom(office.id)!.furniture).toHaveLength(after.furniture.length);
  });

  it("los agentes con sala propia no cambian", () => {
    const zen = getChief()!;
    expect(zen.deskSeatId).toBeNull();
    expect(getRoom(zen.roomId!)!.agentId).toBe(zen.id);
    hireAgent({ name: "Ana", specialty: "finanzas" });
    expect(getChief()!.roomId).toBe(zen.roomId);
  });
});

describe("salas compartidas por todo el equipo", () => {
  it("un agente que no es el jefe decora la sala de otro y una común", async () => {
    const zen = getChief()!;
    const lucy = hireAgent({ name: "Lucy", specialty: "desarrollo" });
    const comun = buildRoom({ name: "Biblioteca", domain: "lectura" });
    const { call } = toolsFor(lucy);
    const zenRoom = getRoom(zen.roomId!)!;

    const r1 = await call("sala_decorar", { sala: zenRoom.name, anadir: ["planta"] });
    expect(r1.isError).toBeFalsy();
    expect(getRoom(zenRoom.id)!.furniture.length).toBe(zenRoom.furniture.length + 1);

    const before = getRoom(comun.id)!.furniture.length;
    const r2 = await call("sala_decorar", { sala: "biblioteca", anadir: ["cojin"] });
    expect(r2.isError).toBeFalsy();
    expect(getRoom(comun.id)!.furniture.length).toBe(before + 1);
    // El dueño de referencia no cambia.
    expect(getRoom(zenRoom.id)!.agentId).toBe(zen.id);
  });

  it("cualquier agente puede crear y renombrar salas", async () => {
    const lucy = hireAgent({ name: "Lucy", specialty: "desarrollo" });
    const zen = getChief()!;
    const { call } = toolsFor(lucy);
    expect((await call("sala_crear", { nombre: "Taller", ambito: "proyectos" })).isError).toBeFalsy();
    const taller = listRooms().find((r) => r.name === "Taller")!;
    expect(taller.agentId).toBeNull();
    await call("sala_renombrar", { sala: getRoom(zen.roomId!)!.name, nombre: "Sala de mando" });
    expect(getRoom(zen.roomId!)!.name).toBe("Sala de mando");
  });

  it("sala_ir mueve al agente; sin sala (o a la suya) vuelve", async () => {
    const lucy = hireAgent({ name: "Lucy", specialty: "desarrollo" });
    const zen = getChief()!;
    const zenRoom = getRoom(zen.roomId!)!;
    const { call } = toolsFor(lucy);

    await call("sala_ir", { sala: zenRoom.name });
    expect(getAgent(lucy.id)!.locationRoomId).toBe(zenRoom.id);
    // Sin sala, decorar actúa donde está ahora.
    const n = getRoom(zenRoom.id)!.furniture.length;
    await call("sala_decorar", { anadir: ["planta"] });
    expect(getRoom(zenRoom.id)!.furniture.length).toBe(n + 1);

    await call("sala_ir", {});
    expect(getAgent(lucy.id)!.locationRoomId).toBeNull();
    await call("sala_ir", { sala: zenRoom.name });
    await call("sala_ir", { sala: getRoom(lucy.roomId!)!.name });
    expect(getAgent(lucy.id)!.locationRoomId).toBeNull();
    expect((await call("sala_ir", { sala: "no existe" })).isError).toBe(true);
  });

  it("el contexto lista todas las salas con dueño, quién está y sus muebles", async () => {
    hireAgent({ name: "Gwen", specialty: "decoración de interiores" });
    const lucy = hireAgent({ name: "Lucy", specialty: "desarrollo" });
    const zenRoom = getRoom(getChief()!.roomId!)!;
    const office = getRoom(lucy.roomId!)!;
    editAgent(lucy.id, { locationRoomId: zenRoom.id });
    const me = getAgent(lucy.id)!;
    const task = createTask({ agentId: me.id, kind: "chat", prompt: "x" });
    const ctx = buildContext(me, task);
    expect(ctx).toContain("Salas de la casa (todas se pueden usar y decorar)");
    for (const r of listRooms()) expect(ctx).toContain(`- ${r.name} (`);
    expect(ctx).toContain(`${zenRoom.name} (de Zen) ← estás aquí · aquí: Zen`);
    expect(ctx).toContain(`${office.name} (común, aquí tienes tu escritorio) · aquí: Gwen`);
    expect(ctx).toMatch(/muebles: .*Escritorio/);
    expect(buildSystemPrompt(me, task)).toContain("todas son de todos");
  });

  it("API: mover a un agente valida la sala; borrar una sala devuelve a sus visitantes", () => {
    const lucy = hireAgent({ name: "Lucy", specialty: "desarrollo" });
    const comun = buildRoom({ name: "Gimnasio", domain: "deporte" });
    expect(() => editAgent(lucy.id, { locationRoomId: "nada" })).toThrow("No existe esa sala");
    expect(editAgent(lucy.id, { locationRoomId: comun.id }).locationRoomId).toBe(comun.id);
    // Mover y editar a la vez.
    expect(editAgent(lucy.id, { locationRoomId: lucy.roomId, specialty: "código" })).toMatchObject({ locationRoomId: null, specialty: "código" });
    editAgent(lucy.id, { locationRoomId: comun.id });
    deleteRoom(comun.id);
    expect(getAgent(lucy.id)!.locationRoomId).toBeNull();
  });
});
