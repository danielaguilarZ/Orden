import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { logActivity } from "@/lib/repo/system";
import { updateRoom } from "@/lib/repo/rooms";
import { purgeRoom, redecorateRoom, refurnishRoom, removeRoom, restoreRoom, setRoomFinish, setRoomLayout } from "@/lib/rooms";

export const dynamic = "force-dynamic";

const item = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().optional(),
  flip: z.boolean().optional(),
  tint: z.record(z.string(), z.string()).optional(),
  manual: z.boolean().optional(),
});

const schema = z.object({
  name: z.string().trim().min(1).optional(),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
  refurnish: z.boolean().optional(),
  /** Distribución completa hecha a mano en el editor de sala. */
  furniture: z.array(item).max(200).optional(),
  /** Sacarla de la papelera. */
  restore: z.literal(true).optional(),
  /** Suelo y/o paredes del catálogo de acabados (id). */
  finish: z.object({ suelo: z.string().max(60).optional(), pared: z.string().max(60).optional() }).optional(),
});

/** Renombrar, cambiar suelo/paredes, añadir/quitar muebles, guardar la distribución manual, reamueblar o recuperar de la papelera. */
export const PATCH = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const input = schema.parse(await body(req));
  if (input.restore) {
    const room = restoreRoom(id);
    logActivity("sistema", `Sala «${room.name}» recuperada de la papelera`, null, { roomId: room.id });
    return room;
  }
  if (input.name) updateRoom(id, { name: input.name });
  if (input.finish && (input.finish.suelo || input.finish.pared)) {
    const { room } = setRoomFinish(id, input.finish);
    if (!input.furniture && !input.refurnish && !input.add && !input.remove) return room;
  }
  if (input.furniture) return setRoomLayout(id, input.furniture);
  if (input.refurnish) return refurnishRoom(id);
  if (input.add || input.remove) return redecorateRoom(id, { add: input.add, remove: input.remove });
  return { ok: true };
});

/**
 * Borra una sala: a la papelera (recuperable). ?relocate=1 confirma que a
 * quien tenga aquí su escritorio se le asigne otro; ?forever=1 la borra del
 * todo (solo si ya está en la papelera).
 */
export const DELETE = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  if (q.get("forever") === "1") {
    const room = purgeRoom(id);
    logActivity("sistema", `Sala «${room.name}» borrada para siempre`, null, { roomId: room.id });
    return { ok: true };
  }
  const { room, relocated } = removeRoom(id, { relocate: q.get("relocate") === "1" });
  const moved = relocated.map((r) => `${r.agent} → ${r.room}`).join(", ");
  logActivity("sistema", `Sala «${room.name}» enviada a la papelera${moved ? ` (escritorios reasignados: ${moved})` : ""}`, null, { roomId: room.id });
  return { room, relocated };
});
