"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import type { Agent, Conversation, Message, Task } from "@/lib/types";
import { Markdown } from "./Markdown";
import { AvatarPreview } from "./AvatarPreview";
import { CodeChangeCard } from "./CodeChangeCard";
import { AttachButton, AttachmentTray, DropZone, MessageAttachments, useAttachments } from "./Attachments";
import type { AttachmentRef } from "@/lib/files/attachments";

interface ChatData {
  conversation: Conversation;
  messages: Message[];
  tasks: Task[];
}

const TASK_LABEL: Record<string, string> = {
  queued: "En cola",
  running: "Trabajando",
  waiting: "Esperando a otros agentes",
};

export function AgentChat({ agent, autoFocus }: { agent: Agent; autoFocus?: boolean }) {
  const [data, setData] = useState<ChatData | null>(null);
  const [stream, setStream] = useState<{ taskId: string; text: string } | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const files = useAttachments();
  const agents = useStore((s) => s.agents);
  const worker = useStore((s) => s.worker);
  const convId = data?.conversation.id;

  const load = useCallback(async () => {
    const d = await api<ChatData>(`/api/agents/${agent.id}/chat`).catch(() => null);
    if (d) setData(d);
  }, [agent.id]);

  useEffect(() => {
    setData(null);
    setStream(null);
    load();
  }, [load]);

  useEffect(
    () =>
      onEvent((e) => {
        const p = e.payload as Record<string, unknown>;
        if (e.type === "message.created" && p.conversationId === convId) {
          const msg = p as unknown as Message;
          setData((d) => (d && !d.messages.some((m) => m.id === msg.id) ? { ...d, messages: [...d.messages, msg] } : d));
          if (msg.role === "agent") setStream(null);
        } else if (e.type === "message.stream" && p.conversationId === convId) {
          setStream(p.done ? null : { taskId: String(p.taskId), text: String(p.text ?? "") });
        } else if ((e.type === "task.created" || e.type === "task.updated") && p.agentId === agent.id) {
          const t = p as unknown as Task;
          if (t.kind === "ambient") return;
          setData((d) => {
            if (!d) return d;
            const rest = d.tasks.filter((x) => x.id !== t.id);
            return { ...d, tasks: ["queued", "running", "waiting"].includes(t.status) ? [t, ...rest] : rest };
          });
          if (!["queued", "running", "waiting"].includes(t.status)) setStream((s) => (s?.taskId === t.id ? null : s));
        } else if (e.type === "conversation.reset" && p.agentId === agent.id) {
          load();
        }
      }),
    [convId, agent.id, load],
  );

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data?.messages.length, stream?.text, data?.tasks.length]);

  const canSend = (text.trim().length > 0 || files.ids.length > 0) && !files.uploading && !sending;

  async function send() {
    const value = text.trim();
    if (!canSend) return;
    setSending(true);
    setError("");
    try {
      await api(`/api/agents/${agent.id}/chat`, { method: "POST", json: { text: value, attachments: files.ids } });
      setText("");
      files.clear();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function cancel(taskId: string) {
    await api(`/api/tasks/${taskId}/cancel`, { method: "POST" }).catch((err) => setError(err.message));
  }

  async function reset() {
    if (!confirm(`¿Empezar una conversación nueva con ${agent.name}? Olvidará el hilo actual (la memoria compartida se mantiene).`)) return;
    await api(`/api/agents/${agent.id}/chat`, { method: "DELETE" });
  }

  const byId = (id: string | null) => agents.find((a) => a.id === id);
  const queuedWhileStopped = !worker?.alive && data?.tasks.some((t) => t.status === "queued");

  return (
    <DropZone className="chat" onFiles={files.add} label={`Suelta para enviárselo a ${agent.name}`}>
      <div className="chat-list" ref={listRef}>
        {!data && <p className="muted center">Cargando…</p>}
        {data && data.messages.length === 0 && (
          <div className="chat-empty">
            <p>
              {agent.isChief
                ? `Cuéntale a ${agent.name} qué necesitas. Lo hará él o lo repartirá entre el equipo.`
                : `Encárgale algo a ${agent.name} directamente.`}
            </p>
            {agent.isChief && (
              <div className="suggestions">
                {[
                  "Créame un calendario con mis tareas de esta semana",
                  "Monta un equipo para llevar mis finanzas personales",
                  "Hazme una lista de trámites pendientes típicos de octubre",
                ].map((s) => (
                  <button key={s} className="chip" onClick={() => setText(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {data?.messages.map((m) => {
          if (m.role === "tool")
            return (
              <div key={m.id} className="msg-tool">
                <span className="tool-dot" />
                {m.content}
              </div>
            );
          if (m.role === "system")
            return (
              <div key={m.id} className="msg-system">
                {m.content}
              </div>
            );
          if (m.role === "user") {
            const from = typeof m.data.fromName === "string" ? byId(String(m.data.fromAgentId)) : null;
            if (from)
              return (
                <div key={m.id} className="msg msg-agent msg-from-agent">
                  <div className="msg-avatar">
                    <AvatarPreview appearance={from.appearance} scale={1} />
                  </div>
                  <div className="msg-body">
                    <div className="msg-meta">
                      Encargo de {from.name} → {agent.name}
                    </div>
                    <Markdown text={m.content} />
                  </div>
                </div>
              );
            return (
              <div key={m.id} className="msg msg-user">
                <div className="msg-body">
                  {m.content && <Markdown text={m.content} />}
                  <MessageAttachments refs={(m.data.attachments as AttachmentRef[]) ?? []} />
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className="msg msg-agent">
              <div className="msg-avatar">
                <AvatarPreview appearance={agent.appearance} scale={1} />
              </div>
              <div className="msg-body">
                <div className="msg-meta">{agent.name}</div>
                <Markdown text={m.content} />
              </div>
            </div>
          );
        })}
        {stream?.text && (
          <div className="msg msg-agent streaming">
            <div className="msg-avatar">
              <AvatarPreview appearance={agent.appearance} scale={1} />
            </div>
            <div className="msg-body">
              <div className="msg-meta">{agent.name}</div>
              <Markdown text={stream.text} />
              <span className="caret" />
            </div>
          </div>
        )}
      </div>

      {agent.admin && <CodeChangeCard agentId={agent.id} />}

      {data && data.tasks.length > 0 && (
        <div className="chat-tasks">
          {data.tasks.map((t) => (
            <div key={t.id} className={`task-chip t-${t.status}`}>
              {t.status !== "queued" && <span className="spinner" />}
              <span className="task-label">
                {TASK_LABEL[t.status]}
                {t.kind === "delegation" && t.createdBy && byId(t.createdBy) && ` · encargo de ${byId(t.createdBy)!.name}`}
                {t.kind === "routine" && " · rutina"}
              </span>
              <span className="task-title">{t.title}</span>
              <button className="btn ghost small" onClick={() => cancel(t.id)} disabled={t.cancelRequested}>
                {t.cancelRequested ? "Cancelando…" : "Cancelar"}
              </button>
            </div>
          ))}
          {queuedWhileStopped && (
            <p className="warn-text small">El worker está parado: el encargo espera en cola. Arranca la app con npm run dev o cancélalo.</p>
          )}
        </div>
      )}

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <AttachmentTray items={files.items} onRemove={files.remove} />
        <textarea
          value={text}
          autoFocus={autoFocus}
          onPaste={files.onPaste}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={agent.paused ? `${agent.name} está en pausa: los encargos esperarán.` : `Escribe a ${agent.name}… (arrastra o pega capturas y archivos)`}
          rows={2}
        />
        <div className="chat-actions">
          <button type="button" className="btn ghost small" onClick={reset} title="Nueva conversación">
            Nueva conversación
          </button>
          <AttachButton onFiles={files.add} />
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={!canSend}>
            Enviar
          </button>
        </div>
        {error && <p className="bad-text small">{error}</p>}
      </form>
    </DropZone>
  );
}
