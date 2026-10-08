import { z } from "zod";
import { route, body, type IdCtx } from "@/lib/http";
import { getAgent } from "@/lib/repo/agents";
import { activeConversation, addMessage, listMessages, resetConversation } from "@/lib/repo/chat";
import { ACTIVE, createTask, listTasks } from "@/lib/repo/tasks";
import { attachmentRefs, MAX_ATTACHMENTS } from "@/lib/chat/attachments";

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
  .object({
    text: z.string().trim().max(8000).default(""),
    /** Ids de archivos ya subidos con /api/chat/attachments. */
    attachments: z.array(z.string()).max(MAX_ATTACHMENTS, `Como máximo ${MAX_ATTACHMENTS} adjuntos por mensaje.`).optional(),
  })
  .refine((d) => d.text || d.attachments?.length, { message: "Escribe algo o adjunta un archivo" });

/** Envía un mensaje (con adjuntos opcionales): queda como encargo en la cola del worker. */
export const POST = route<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) throw new Error("No existe ese agente.");
  const input = sendSchema.parse(await body(req));
  const files = attachmentRefs(input.attachments);
  const text = input.text;
  const prompt = text || "Te adjunto estos archivos.";
  const title = text || `Adjuntos: ${files.map((f) => f.name).join(", ")}`;
  const conversation = activeConversation(id);
  const task = createTask({
    agentId: id,
    kind: "chat",
    conversationId: conversation.id,
    prompt,
    title,
    data: files.length ? { attachments: files.map((f) => f.id) } : {},
  });
  const message = addMessage({
    conversationId: conversation.id,
    role: "user",
    content: text,
    taskId: task.id,
    data: files.length ? { attachments: files } : {},
  });
  return { task, message };
});

/** Empieza una conversación nueva (el agente olvida el hilo anterior). */
export const DELETE = route<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  return { conversation: resetConversation(id) };
});
