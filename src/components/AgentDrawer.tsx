"use client";

import { useState } from "react";
import type { Agent } from "@/lib/types";
import { getPersonality } from "@/lib/personalities";
import { api, useStore } from "@/client/store";
import { hasMore, plural, summarize } from "@/lib/ui/text";
import { AvatarPreview } from "./AvatarPreview";
import { AgentChat } from "./AgentChat";
import { AgentForm } from "./AgentForm";
import { RoutinesTab } from "./RoutinesTab";
import { RoomSection } from "./RoomSection";

export const STATUS_LABEL: Record<string, string> = {
  idle: "Disponible",
  working: "Trabajando",
  waiting: "Esperando",
  sleeping: "Durmiendo",
  error: "Error",
};

const MODEL: Record<string, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

/** Panel lateral del agente: chat directo y ficha. */
export function AgentDrawer({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tab, setTab] = useState<"chat" | "rutinas" | "ficha">("chat");
  const [editing, setEditing] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const status = agent.paused ? "sleeping" : agent.status;
  const personality = getPersonality(agent.personality.preset);
  const rooms = useStore((s) => s.rooms);

  async function togglePause() {
    await api(`/api/agents/${agent.id}`, { method: "PATCH", json: { paused: !agent.paused } });
  }

  async function remove() {
    if (!confirm(`¿Seguro que quieres borrar a ${agent.name}? Se cancelarán sus encargos${rooms.some((r) => r.agentId === agent.id) ? " y desaparecerá su sala" : " y su escritorio quedará libre"}.`)) return;
    await api(`/api/agents/${agent.id}`, { method: "DELETE" });
    onClose();
  }

  return (
    <aside className="drawer" key={agent.id}>
      <header className="drawer-head">
        <AvatarPreview appearance={agent.appearance} scale={2} />
        <div className="drawer-title">
          <h2>
            {agent.name} {agent.isChief && <span className="tag gold">Jefe</span>}
            {agent.admin && <span className="tag admin">Admin</span>}
          </h2>
          <p className="muted">{agent.specialty}</p>
          <span className={`status-chip st-${status}`}>
            {STATUS_LABEL[status]}
            {agent.statusText && ` · ${agent.statusText}`}
          </span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
          ×
        </button>
      </header>
      <nav className="tabs">
        <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
          Chat
        </button>
        <button className={tab === "rutinas" ? "on" : ""} onClick={() => setTab("rutinas")}>
          Rutinas
        </button>
        <button className={tab === "ficha" ? "on" : ""} onClick={() => setTab("ficha")}>
          Ficha
        </button>
      </nav>
      {tab === "chat" ? (
        <AgentChat agent={agent} autoFocus />
      ) : tab === "rutinas" ? (
        <RoutinesTab agent={agent} />
      ) : (
        <div className="drawer-scroll">
          <dl className="facts">
            <dt>Modelo</dt>
            <dd>{MODEL[agent.model]}</dd>
            <dt>Personalidad</dt>
            <dd>
              <strong>{personality.label}</strong> — {agent.personality.description || personality.description}
            </dd>
            <dt>Forma de hablar</dt>
            <dd>{agent.personality.voice || personality.voice}</dd>
            {agent.instructions && (
              <>
                <dt>Instrucciones</dt>
                <dd className={showInstructions ? "pre" : ""}>
                  {showInstructions || !hasMore(agent.instructions, 140) ? agent.instructions : summarize(agent.instructions, 140)}
                  {hasMore(agent.instructions, 140) && (
                    <>
                      {" "}
                      <button className="ui-link" onClick={() => setShowInstructions((v) => !v)}>
                        {showInstructions ? "Ocultar" : "Ver todas"}
                      </button>
                    </>
                  )}
                </dd>
              </>
            )}
            {agent.ambient.length > 0 && (
              <>
                <dt>Frases</dt>
                <dd>
                  <details className="ui-fold">
                    <summary>{plural(Math.min(agent.ambient.length, 8), "frase de ambiente", "frases de ambiente")}</summary>
                    <ul className="phrases">
                      {agent.ambient.slice(0, 8).map((p) => (
                        <li key={p}>«{p}»</li>
                      ))}
                    </ul>
                  </details>
                </dd>
              </>
            )}
          </dl>
          <RoomSection agent={agent} />
          <div className="drawer-actions">
            <button className="btn" onClick={() => setEditing(true)}>
              Editar
            </button>
            <button className="btn" onClick={togglePause}>
              {agent.paused ? "Reanudar" : "Pausar"}
            </button>
            {!agent.isChief && (
              <button className="btn danger" onClick={remove}>
                Borrar
              </button>
            )}
          </div>
        </div>
      )}
      {editing && <AgentForm agent={agent} onClose={() => setEditing(false)} />}
    </aside>
  );
}
