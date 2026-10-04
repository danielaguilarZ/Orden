import { expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { listAgents } from "@/lib/repo/agents";
import { listRooms } from "@/lib/repo/rooms";
import { roomContext } from "@/living/roomEditor";
import { describeRoomLayout, shortIds } from "@/living/roomMap";

// Plano de todas las salas sembradas: cada mueble sale con su id y no hay solapes.
it("sala_ver describe todas las salas iniciales sin solapes", () => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  const rooms = listRooms();
  expect(rooms).toHaveLength(1);
  for (const r of rooms) {
    const text = describeRoomLayout(r, rooms, listAgents(), roomContext(r, rooms));
    expect(text).toContain(`Sala «${r.name}»`);
    expect(text).toMatch(/Plano:/);
    const ids = shortIds(r.furniture);
    for (const f of r.furniture) expect(text).toContain(`[${ids.get(f.id)}]`);
    expect(text).not.toMatch(/se solapan/);
  }
});
