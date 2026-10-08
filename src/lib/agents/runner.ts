import path from "node:path";
import fs from "node:fs";
import { createSdkMcpServer, query as sdkQuery, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeBinaryPath, claudeEnv } from "../claude/binary";
import { getAgent, setAgentStatus, updateAgent } from "../repo/agents";
import { addMessage, getConversation, listMessages, setConversationSession } from "../repo/chat";
import { finishTask, getTask, listTasks } from "../repo/tasks";
import { logActivity } from "../repo/system";
import { emit } from "../events";
import { buildSystemPrompt, buildUserMessage } from "./prompt";
import { ADMIN_ALLOWED, ADMIN_TOOLS, isAdminTask } from "../dev/admin";
import { captureChanges, ensureWorkspace } from "../dev/workspace";
import { createHash } from "node:crypto";
import { buildTools } from "./tools";
import { loadAttachments, promptWithAttachments } from "../chat/attachments";
import type { Agent, Task, TaskUsage } from "../types";

/**
 * Ejecuta un encargo con el Claude Agent SDK.
 * - Sin herramientas integradas (`tools: []`), solo el servidor MCP «orden».
 * - Sin preguntas de permisos: `dontAsk` + solo nuestras herramientas permitidas.
 * - El uso se toma únicamente del mensaje `result` (los parciales repiten uso).
 */

export type QueryFn = typeof sdkQuery;

const MODEL_IDS: Record<string, string> = { haiku: "haiku", sonnet: "sonnet", opus: "opus" };

function agentsCwd(): string {
  // Carpeta neutra: así el SDK no carga CLAUDE.md ni ajustes de ningún proyecto.
  const dir = path.join(path.dirname(process.env.ORDEN_DB_PATH ?? path.join(process.cwd(), "data", "orden.db")), "agentes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function usageFrom(m: Extract<SDKMessage, { type: "result" }>): TaskUsage {
  return {
    inputTokens: m.usage.input_tokens ?? 0,
    outputTokens: m.usage.output_tokens ?? 0,
    cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
    costUsd: m.total_cost_usd ?? 0,
    turns: m.num_turns ?? 0,
    durationMs: m.duration_ms ?? 0,
  };
}

function baseOptions(agent: Agent, abort: AbortController): Options {
  return {
    model: MODEL_IDS[agent.model] ?? "haiku",
    tools: [],
    allowedTools: ["mcp__orden"],
    permissionMode: "dontAsk",
    settingSources: [],
    // Solo nuestras herramientas: ni conectores de claude.ai ni MCP del usuario
    // (si no, sus definiciones llenan el contexto en cada llamada).
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
    cwd: agentsCwd(),
    abortController: abort,
    pathToClaudeCodeExecutable: claudeBinaryPath() ?? undefined,
    env: claudeEnv({ MCP_TOOL_TIMEOUT: "1800000" }),
    // Haiku sin «thinking» para gastar poco; el resto con esfuerzo medio.
    ...(agent.model === "haiku" ? { thinking: { type: "disabled" as const } } : { effort: "medium" as const }),
  };
}

/** Últimos mensajes de la conversación, para no perder el hilo al empezar sesión nueva. */
function recentRecap(conversationId: string, currentTaskId: string): string | undefined {
  const msgs = listMessages(conversationId, 30)
    .filter((m) => (m.role === "user" || m.role === "agent") && m.taskId !== currentTaskId)
    .slice(-8);
  if (!msgs.length) return undefined;
  return msgs
    .map((m) => `${m.role === "user" ? (typeof m.data.fromName === "string" ? m.data.fromName : "Usuario") : "Tú"}: ${m.content.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
}

export interface RunOptions {
  queryFn?: QueryFn;
  abort?: AbortController;
}

/** Recorta un texto largo para el bocadillo del living. */
function short(text: string, n = 48) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export async function runTask(task: Task, opts: RunOptions = {}): Promise<Task> {
  const queryFn = opts.queryFn ?? sdkQuery;
  const abort = opts.abort ?? new AbortController();
  const agent = getAgent(task.agentId);
  if (!agent) return finishTask(task.id, "error", { error: "El agente ya no existe." });

  if (task.kind === "ambient") return runAmbient(task, agent, queryFn, abort);

  const conv = task.conversationId ? getConversation(task.conversationId) : null;
  setAgentStatus(agent.id, "working", short(task.kind === "chat" ? "Pensando…" : task.title));
  logActivity(task.kind === "routine" ? "rutina" : "encargo", `${agent.name} empieza: ${short(task.title, 90)}`, agent.id, { taskId: task.id });

  const notes: string[] = [];
  const ctx = {
    agent,
    task,
    signal: abort.signal,
    note: (text: string, data: Record<string, unknown> = {}) => {
      notes.push(text);
      if (conv) addMessage({ conversationId: conv.id, role: "tool", content: text, agentId: agent.id, taskId: task.id, data });
    },
  };

  const server = createSdkMcpServer({ name: "orden", version: "1.0.0", tools: buildTools(ctx), alwaysLoad: true });
  const systemPrompt = buildSystemPrompt(agent, task);
  const hash = createHash("sha1").update(systemPrompt).digest("hex").slice(0, 16);
  // Al reanudar, el SDK conserva el prompt de sistema con el que empezó la
  // sesión. Si el agente se editó desde entonces, se empieza una sesión nueva
  // con un resumen de lo último hablado.
  const canResume = task.kind === "chat" && Boolean(conv?.sessionId) && conv?.promptHash === hash;
  const resume = canResume ? conv!.sessionId! : undefined;
  const recapFor = (resumeId: string | undefined) =>
    !resumeId && task.kind === "chat" && conv ? recentRecap(conv.id, task.id) : undefined;

  /** Tras trabajar en el código: lo que haya cambiado queda como propuesta en el chat. */
  const reportChanges = async (summary: string) => {
    try {
      const change = await captureChanges(agent, task.id, summary);
      if (change && change.files.length && conv) {
        addMessage({
          conversationId: conv.id,
          role: "tool",
          content: `Ha preparado cambios de código en ${change.files.length} archivo(s): revísalos y aplícalos o descártalos.`,
          agentId: agent.id,
          taskId: task.id,
          data: { kind: "code", changeId: change.id },
        });
      }
    } catch (err) {
      logActivity("error", `No pude leer los cambios de ${agent.name}: ${short((err as Error).message, 100)}`, agent.id);
    }
  };

  // Agentes admin: herramientas de código, pero solo dentro de su copia del proyecto.
  const admin = isAdminTask(agent, task.kind);
  let devOptions: Partial<Options> = {};

  // Adjuntos del chat: su texto va en el mensaje y las imágenes como imágenes reales.
  const attachments = task.kind === "chat" ? loadAttachments(task.data.attachments) : null;

  const attempt = async (resumeId: string | undefined) => {
    const q = queryFn({
      prompt: promptWithAttachments(buildUserMessage(agent, task, recapFor(resumeId)), attachments),
      options: {
        ...baseOptions(agent, abort),
        ...devOptions,
        systemPrompt,
        mcpServers: { orden: server },
        includePartialMessages: Boolean(conv),
        ...(resumeId && { resume: resumeId }),
      },
    });
    let lastText = "";
    let streamText = "";
    let lastStreamAt = 0;
    let result: Extract<SDKMessage, { type: "result" }> | null = null;
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        if (conv && task.kind === "chat") setConversationSession(conv.id, m.session_id, hash);
      } else if (m.type === "stream_event" && conv) {
        const ev = m.event as { type: string; delta?: { type: string; text?: string } };
        if (ev.type === "message_start") streamText = "";
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          streamText += ev.delta.text ?? "";
          if (Date.now() - lastStreamAt > 150) {
            lastStreamAt = Date.now();
            emit("message.stream", { conversationId: conv.id, taskId: task.id, agentId: agent.id, text: streamText });
          }
        }
      } else if (m.type === "assistant" && !m.parent_tool_use_id) {
        const text = m.message.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (text) {
          lastText = text;
          if (conv) addMessage({ conversationId: conv.id, role: "agent", content: text, agentId: agent.id, taskId: task.id });
          emit("message.stream", { conversationId: conv?.id, taskId: task.id, agentId: agent.id, text: "", done: true });
        }
      } else if (m.type === "result") {
        result = m;
      }
    }
    return { lastText, result };
  };

  try {
    if (admin) {
      setAgentStatus(agent.id, "working", "Preparando su copia del código");
      const ws = await ensureWorkspace(agent);
      devOptions = {
        cwd: ws.dir,
        tools: ADMIN_TOOLS,
        allowedTools: [...ADMIN_ALLOWED, "mcp__orden"],
        ...(agent.model !== "haiku" && { effort: "high" as const }),
      };
    }
    let out: Awaited<ReturnType<typeof attempt>>;
    try {
      out = await attempt(resume);
    } catch (err) {
      // Si la sesión guardada ya no existe, se empieza una nueva.
      if (resume && !abort.signal.aborted && /session|conversation/i.test(String((err as Error).message))) {
        if (conv) setConversationSession(conv.id, null);
        out = await attempt(undefined);
      } else throw err;
    }
    const { lastText, result } = out;
    const usage = result ? usageFrom(result) : null;
    if (abort.signal.aborted || getTask(task.id)?.cancelRequested) {
      return finishTask(task.id, "cancelled", { error: "Cancelado", usage });
    }
    if (!result || result.subtype !== "success") {
      const errors = result && "errors" in result ? result.errors.join("; ") : "";
      throw new Error(errors || "La ejecución terminó sin resultado.");
    }
    const finalText = lastText || result.result || (notes.length ? notes.join("\n") : "Hecho.");
    if (admin) await reportChanges(finalText);
    const done = finishTask(task.id, "done", { result: finalText, usage });
    logActivity(task.kind === "routine" ? "rutina" : "encargo", `${agent.name} termina: ${short(task.title, 90)}`, agent.id, {
      taskId: task.id,
    });
    if (task.kind === "delegation" && task.parentId) {
      const parent = getTask(task.parentId);
      if (parent) emit("agent.visit", { fromId: agent.id, toId: parent.agentId, text: "¡Listo! Aquí lo tienes." });
    }
    return done;
  } catch (err) {
    const cancelled = abort.signal.aborted || getTask(task.id)?.cancelRequested;
    if (cancelled) return finishTask(task.id, "cancelled", { error: "Cancelado" });
    const message = (err as Error).message || String(err);
    if (admin) await reportChanges(`(El encargo terminó con error: ${message})`);
    setAgentStatus(agent.id, "error", short(message, 60));
    if (conv) addMessage({ conversationId: conv.id, role: "system", content: `No he podido terminar: ${message}`, agentId: agent.id, taskId: task.id });
    logActivity("error", `${agent.name}: ${short(message, 120)}`, agent.id, { taskId: task.id });
    return finishTask(task.id, "error", { error: message });
  } finally {
    const fresh = getAgent(agent.id);
    const stillBusy = listTasks({ agentId: agent.id, statuses: ["running", "waiting"] }).some((t) => t.id !== task.id && t.kind !== "ambient");
    if (fresh && fresh.status !== "error" && !stillBusy) setAgentStatus(agent.id, "idle", "");
  }
}

/** Genera una sola vez frases de ambiente para un carácter personalizado. */
async function runAmbient(task: Task, agent: Agent, queryFn: QueryFn, abort: AbortController): Promise<Task> {
  try {
    const q = queryFn({
      prompt: `Personaje: ${agent.name}. Especialidad: ${agent.specialty}. Carácter: ${agent.personality.description}. Forma de hablar: ${agent.personality.voice}.
Escribe 8 frases cortas (máximo 7 palabras cada una) que este personaje diría para sí mientras pasea por su oficina. En español, con su carácter.
Responde SOLO con un array JSON de strings.`,
      options: { ...baseOptions({ ...agent, model: "haiku" }, abort), systemPrompt: "Eres un guionista conciso.", maxTurns: 1 },
    });
    let text = "";
    let usage: TaskUsage | null = null;
    for await (const m of q) {
      if (m.type === "result") {
        usage = usageFrom(m);
        if (m.subtype === "success") text = m.result;
      }
    }
    const match = text.match(/\[[\s\S]*\]/);
    const phrases = match ? (JSON.parse(match[0]) as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 12) : [];
    if (!phrases.length) throw new Error("No he recibido frases válidas.");
    updateAgent(agent.id, { ambient: phrases });
    return finishTask(task.id, "done", { result: phrases.join(" | "), usage });
  } catch (err) {
    return finishTask(task.id, "error", { error: (err as Error).message });
  }
}
