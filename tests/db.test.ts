import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { createAgent, deleteAgent, getChief, listAgents, setAgentStatus, updateAgent } from "@/lib/repo/agents";
import { listRooms } from "@/lib/repo/rooms";
import { eventsAfter } from "@/lib/events";
import { ensureSeed } from "@/lib/seed";

beforeEach(() => setDbForTests(openDb(":memory:")));

describe("base de datos y semilla", () => {
  it("crea a Zen y su despacho (la única sala) una sola vez", () => {
    ensureSeed();
    ensureSeed();
    const agents = listAgents();
    expect(agents).toHaveLength(1);
    const zen = getChief()!;
    expect(zen.name).toBe("Zen");
    expect(zen.model).toBe("sonnet");
    const rooms = listRooms();
    expect(rooms.map((r) => r.kind)).toEqual(["despacho_zen"]);
    expect(rooms[0].agentId).toBe(zen.id);
    expect(zen.roomId).toBe(rooms[0].id);
  });

  it("Zen no se puede borrar; otros agentes sí", () => {
    ensureSeed();
    expect(() => deleteAgent(getChief()!.id)).toThrow(/no se puede borrar/);
    const ana = createAgent({ name: "Ana", specialty: "Finanzas" });
    deleteAgent(ana.id);
    expect(listAgents().map((a) => a.name)).toEqual(["Zen"]);
  });

  it("cada cambio emite un evento para el tiempo real", () => {
    const ana = createAgent({ name: "Ana" });
    updateAgent(ana.id, { model: "opus" });
    setAgentStatus(ana.id, "working", "Calculando");
    const types = eventsAfter(0).map((e) => e.type);
    expect(types).toEqual(["agent.created", "agent.updated", "agent.status"]);
    expect(eventsAfter(0).at(-1)!.payload).toMatchObject({ status: "working", statusText: "Calculando" });
  });
});
