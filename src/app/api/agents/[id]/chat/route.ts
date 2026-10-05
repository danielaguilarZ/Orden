import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { getAgent } from "@/lib/repo/agents";
import { activeConversation, addMessage, listMessages, resetConversation } from "@/lib/repo/chat";
import { ACTIVE, createTask, listTasks } from "@/lib/repo/tasks";

export const dynamic = "force-dynamic";

/** Conversación activa del agente, sus mensajes y encargos en curso. */
export const GET = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  if (!getAgent(id)) throw new Error("No existe ese agente.");
  const conversation = activeConversation(id);
  return {
    conversation,
    messages: listMessages(conversation.id),
    tasks: listTasks({ agentId: id, statuses: ACTIVE, limit: 20 }).filter((t) => t.kind !== "ambient"),
  };
});

const sendSchema = z.object({ text: z.string().trim().min(1, "Escribe algo").max(8000) });

/** Envía un mensaje: queda como encargo en la cola del worker. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) throw new Error("No existe ese agente.");
  const { text } = sendSchema.parse(await body(req));
  const conversation = activeConversation(id);
  const task = createTask({ agentId: id, kind: "chat", conversationId: conversation.id, prompt: text, title: text });
  const message = addMessage({ conversationId: conversation.id, role: "user", content: text, taskId: task.id });
  return { task, message };
});

/** Empieza una conversación nueva (el agente olvida el hilo anterior). */
export const DELETE = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  return { conversation: resetConversation(id) };
});
