import { route, body } from "@/lib/http";
import { cancelLogin, loginInfo, pollLogin, saveClientId, startLogin } from "@/lib/connections/github/login";
import { logActivity } from "@/lib/repo/system";

export const dynamic = "force-dynamic";

/** Estado del inicio de sesión con GitHub (sin secretos): Client ID, código en curso y cuenta conectada. */
export const GET = route(() => loginInfo());

/**
 * Acciones: «cliente» (guarda o borra el Client ID de la OAuth App), «iniciar»
 * (pide el código), «comprobar» (¿ya autorizado?) y «cancelar».
 */
export const POST = route(async (req) => {
  const b = await body<{ accion?: string; clientId?: string | null }>(req);
  switch (b.accion) {
    case "cliente":
      saveClientId(b.clientId ?? null);
      logActivity("sistema", b.clientId ? "Client ID de GitHub guardado" : "Client ID de GitHub borrado");
      return loginInfo();
    case "iniciar":
      return { pending: await startLogin(), info: loginInfo() };
    case "comprobar":
      return pollLogin();
    case "cancelar":
      cancelLogin();
      return loginInfo();
    default:
      throw new Error("Acción desconocida.");
  }
});
