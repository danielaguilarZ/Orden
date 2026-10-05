import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { getAgent } from "@/lib/repo/agents";
import { getPanel } from "@/lib/repo/panels";
import { activeConversation, addMessage } from "@/lib/repo/chat";
import { createTask } from "@/lib/repo/tasks";

export const dynamic = "force-dynamic";

const schema = z.object({ agentId: z.string(), text: z.string().trim().min(1, "Escribe qué quieres cambiar") });

/** Pide a un agente un cambio sobre un panel concreto. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const { agentId, text } = schema.parse(await body(req));
  const panel = getPanel(id);
  const agent = getAgent(agentId);
  if (!panel) throw new Error("No existe ese panel.");
  if (!agent) throw new Error("No existe ese agente.");
  const conv = activeConversation(agentId);
  const prompt = `Sobre el panel «${panel.title}» (id ${panel.id}, tipo ${panel.type}):\n${text}`;
  const task = createTask({ agentId, kind: "chat", conversationId: conv.id, prompt, title: `«${panel.title}»: ${text}` });
  addMessage({ conversationId: conv.id, role: "user", content: text, taskId: task.id, data: { panelId: panel.id, panelTitle: panel.title } });
  return { task };
});
