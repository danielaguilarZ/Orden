import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { getAgent } from "@/lib/repo/agents";
import { activeConversation, addMessage, listMessages, resetConversation } from "@/lib/repo/chat";
import { ACTIVE, createTask, listTasks } from "@/lib/repo/tasks";
import { resolveAttachments } from "@/lib/files/attachments";

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

const sendSchema = z
  .object({ text: z.string().trim().max(8000).default(""), attachments: z.array(z.string()).max(10).default([]) })
  .refine((v) => v.text.length > 0 || v.attachments.length > 0, { message: "Escribe algo o adjunta un archivo" });

/** Envía un mensaje: queda como encargo en la cola del worker. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) throw new Error("No existe ese agente.");
  const input = sendSchema.parse(await body(req));
  const attachments = resolveAttachments(input.attachments);
  // Solo adjuntos, sin texto: que el agente sepa que tiene que mirarlos.
  const text = input.text || "Te paso esto: míralo y dime qué ves o qué necesitas.";
  const title = input.text || `Adjunto: ${attachments.map((a) => a.name).join(", ")}`;
  const conversation = activeConversation(id);
  const task = createTask({ agentId: id, kind: "chat", conversationId: conversation.id, prompt: text, title, data: attachments.length ? { attachments } : {} });
  const message = addMessage({ conversationId: conversation.id, role: "user", content: input.text, taskId: task.id, data: attachments.length ? { attachments } : {} });
  return { task, message };
});

/** Empieza una conversación nueva (el agente olvida el hilo anterior). */
export const DELETE = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  return { conversation: resetConversation(id) };
});
