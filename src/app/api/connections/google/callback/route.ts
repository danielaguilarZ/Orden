import { route } from "@/lib/http";
import { finishAuth } from "@/lib/connections/google/api";
import { logActivity } from "@/lib/repo/system";

export const dynamic = "force-dynamic";

/**
 * Vuelta de Google tras autorizar. Guarda los tokens (cifrados) y devuelve al
 * usuario a Conexiones con el resultado.
 */
export const GET = route(async (req) => {
  const url = new URL(req.url);
  const back = (status: "ok" | "error", msg: string) =>
    new Response(null, { status: 303, headers: { Location: `/conexiones?google=${status}&msg=${encodeURIComponent(msg.slice(0, 300))}` } });
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const denied = url.searchParams.get("error");
  if (denied) return back("error", denied === "access_denied" ? "Has cancelado la autorización en Google." : `Google ha devuelto un error: ${denied}.`);
  if (!state || !code) return back("error", "Faltan datos en la respuesta de Google.");
  try {
    const c = await finishAuth(state, code);
    logActivity("sistema", `Google Calendar autorizado (solo lectura) en «${c.name}»`);
    return back("ok", "Google Calendar autorizado en solo lectura.");
  } catch (err) {
    logActivity("error", `Autorización de Google Calendar: ${(err as Error).message}`);
    return back("error", (err as Error).message);
  }
});
