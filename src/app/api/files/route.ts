import { route, body } from "@/lib/http";
import { createFolder, emptyTrash, listFullAccess, listLiveNodes, listTrash, setFileAccess } from "@/lib/files/repo";
import { ALLOWED_EXTENSIONS, maxFileBytes } from "@/lib/files/rules";
import { getAgent } from "@/lib/repo/agents";
import { logActivity } from "@/lib/repo/system";

export const dynamic = "force-dynamic";

/** Árbol completo (o la papelera con ?trash=1), permisos y límites. */
export const GET = route(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("trash")) return { items: listTrash() };
  return { nodes: listLiveNodes(), fullAccess: listFullAccess(), maxBytes: maxFileBytes(), extensions: ALLOWED_EXTENSIONS };
});

interface Action {
  action?: "carpeta" | "vaciar_papelera" | "acceso";
  parentId?: string | null;
  name?: string;
  private?: boolean;
  agentId?: string;
  todo?: boolean;
}

export const POST = route(async (req) => {
  const b = await body<Action>(req);
  if (b.action === "carpeta") return createFolder({ parentId: b.parentId ?? null, name: String(b.name ?? ""), private: b.private, by: "user" });
  if (b.action === "vaciar_papelera") return { deleted: emptyTrash() };
  if (b.action === "acceso") {
    const agent = getAgent(String(b.agentId ?? ""));
    if (!agent) throw new Error("Ese agente no existe.");
    setFileAccess(agent.id, b.todo ? "todo" : null);
    logActivity("archivos", `${agent.name}: ${b.todo ? "acceso a todos los archivos" : "solo carpetas compartidas"}`, agent.id);
    return { fullAccess: listFullAccess() };
  }
  throw new Error("Acción desconocida.");
});
