import { z } from "zod";
import { route, body } from "@/lib/http";
import { logActivity } from "@/lib/repo/system";
import { listRooms } from "@/lib/repo/rooms";
import { BUILDINGS } from "@/lib/roomTemplates";
import { createBlankRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";

/** Salas en uso o, con ?archived=1, las de la papelera. */
export const GET = route((req) => listRooms({ archived: new URL(req.url).searchParams.get("archived") === "1" }));

const schema = z.object({
  building: z.enum(Object.keys(BUILDINGS) as [string, ...string[]]).optional(),
  name: z.string().trim().max(60).optional(),
});

/** Crea una sala vacía y común (desde el editor de sala) en el edificio pedido (por defecto, la casa). */
export const POST = route(async (req) => {
  const input = schema.parse(await body(req));
  const room = createBlankRoom(input);
  logActivity("sistema", `Sala «${room.name}» creada en ${BUILDINGS[room.building ?? "orden"]?.label ?? room.building}`, null, { roomId: room.id });
  return room;
});
