import { route, body } from "@/lib/http";
import { addConnection, connectionView, listServices } from "@/lib/connections";
import { serviceInfo } from "@/lib/connections/registry";
import { listConnections } from "@/lib/repo/connections";

export const dynamic = "force-dynamic";

/** Servicios disponibles y conexiones (sin secretos: solo una pista del token o el estado OAuth). */
export const GET = route(() => {
  return { services: listServices().map(serviceInfo), connections: listConnections().map(connectionView) };
});

export const POST = route(async (req) => {
  const b = await body<{ service?: string; config?: Record<string, unknown>; name?: string }>(req);
  if (!b.service) throw new Error("Elige un servicio.");
  return connectionView(addConnection(b.service, b.config ?? {}, b.name));
});
