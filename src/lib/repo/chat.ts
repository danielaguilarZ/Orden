import { randomUUID } from "node:crypto";
import { getDb, now, parseJson } from "../db";
import { emit } from "../events";
import type { Conversation, Message, MessageRole } from "../types";

interface ConvRow {
  id: string;
  agent_id: string;
  title: string;
  session_id: string | null;
  prompt_hash: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  agent_id: string | null;
  role: string;
  content: string;
  task_id: string | null;
  data: string;
  created_at: string;
}

const toConv = (r: ConvRow): Conversation => ({
  id: r.id,
  agentId: r.agent_id,
  title: r.title,
  sessionId: r.session_id,
  promptHash: r.prompt_hash,
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMsg = (r: MsgRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  agentId: r.agent_id,
  role: r.role as MessageRole,
  content: r.content,
  taskId: r.task_id,
  data: parseJson(r.data, {}),
  createdAt: r.created_at,
});

export function getConversation(id: string): Conversation | null {
  const row = getDb().prepare("SELECT * FROM conversations WHERE id = ?").get(id) as unknown as ConvRow | undefined;
  return row ? toConv(row) : null;
}

/** Conversación activa del agente (la crea si no hay). */
export function activeConversation(agentId: string): Conversation {
  const row = getDb()
    .prepare("SELECT * FROM conversations WHERE agent_id = ? AND archived = 0 ORDER BY created_at DESC LIMIT 1")
    .get(agentId) as unknown as ConvRow | undefined;
  if (row) return toConv(row);
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare("INSERT INTO conversations (id, agent_id, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)")
    .run(id, agentId, ts, ts);
  return getConversation(id)!;
}

/** Archiva la conversación activa: la siguiente empieza de cero (sesión nueva). */
export function resetConversation(agentId: string): Conversation {
  getDb().prepare("UPDATE conversations SET archived = 1 WHERE agent_id = ? AND archived = 0").run(agentId);
  const conv = activeConversation(agentId);
  emit("conversation.reset", { agentId, conversationId: conv.id });
  return conv;
}

export function setConversationSession(id: string, sessionId: string | null, promptHash: string | null = null) {
  getDb().prepare("UPDATE conversations SET session_id = ?, prompt_hash = ?, updated_at = ? WHERE id = ?").run(sessionId, promptHash, now(), id);
}

export function addMessage(input: {
  conversationId: string;
  role: MessageRole;
  content: string;
  agentId?: string | null;
  taskId?: string | null;
  data?: Record<string, unknown>;
}): Message {
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare(
      "INSERT INTO messages (id, conversation_id, agent_id, role, content, task_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, input.conversationId, input.agentId ?? null, input.role, input.content, input.taskId ?? null, JSON.stringify(input.data ?? {}), ts);
  getDb().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, input.conversationId);
  const msg = toMsg(getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as MsgRow);
  emit("message.created", msg);
  return msg;
}

export function listMessages(conversationId: string, limit = 200): Message[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM (SELECT rowid AS rid, * FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid",
    )
    .all(conversationId, limit) as unknown as MsgRow[];
  return rows.map(toMsg);
}
