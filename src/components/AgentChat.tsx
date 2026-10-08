"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import type { Agent, Conversation, Message, Task } from "@/lib/types";
import { Markdown } from "./Markdown";
import { AvatarPreview } from "./AvatarPreview";
import { CodeChangeCard } from "./CodeChangeCard";
import { ACCEPT, AttachmentList, attachmentsOf, onPasteFiles, PendingList, useAttachments, useFileDrop } from "./Attachments";

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
  const att = useAttachments();
  const { dragging, dropProps } = useFileDrop(att.attach);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
    att.clear();
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const canSend = (text.trim() !== "" || att.ready.length > 0) && !sending && !att.uploading;

  async function send() {
    const value = text.trim();
    if (!canSend) return;
    setSending(true);
    setError("");
    att.setError("");
    try {
      await api(`/api/agents/${agent.id}/chat`, {
        method: "POST",
        json: { text: value, ...(att.ready.length && { attachments: att.ready.map((f) => f.id) }) },
      });
      setText("");
      att.clear();
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
    <div className={`chat ${dragging ? "dragging" : ""}`} {...dropProps}>
      {dragging && <div className="chat-drop">Suelta aquí para adjuntar a {agent.name}</div>}
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
            const files = attachmentsOf(m);
            return (
              <div key={m.id} className="msg msg-user">
                <div className="msg-body">
                  {files.length > 0 && <AttachmentList items={files} />}
                  {m.content && <Markdown text={m.content} />}
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
        <PendingList pending={att.pending} onRemove={att.remove} />
        <textarea
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => onPasteFiles(e, att.attach)}
          placeholder={agent.paused ? `${agent.name} está en pausa: los encargos esperarán.` : `Escribe a ${agent.name}… (arrastra o pega archivos e imágenes)`}
          rows={2}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            att.attach([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <div className="chat-actions">
          <span className="chat-actions-left">
            <button type="button" className="btn ghost small" onClick={() => fileInput.current?.click()} title="Adjuntar archivos o imágenes">
              📎 Adjuntar
            </button>
            <button type="button" className="btn ghost small" onClick={reset} title="Nueva conversación">
              Nueva conversación
            </button>
          </span>
          <button className="btn primary" disabled={!canSend}>
            {att.uploading ? "Subiendo…" : "Enviar"}
          </button>
        </div>
        {(error || att.error) && <p className="bad-text small">{error || att.error}</p>}
      </form>
    </div>
  );
}
