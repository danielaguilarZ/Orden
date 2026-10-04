"use client";

import Link from "next/link";
import { closeLivePanel, useStore } from "@/client/store";
import { PanelCard } from "./panels/PanelCard";

/**
 * Ventana flotante del living: cuando un agente crea o edita un panel, se
 * abre aquí para verlo construirse en directo.
 */
export function LivePanelDock() {
  const live = useStore((s) => s.livePanel);
  const panel = useStore((s) => s.panels.find((p) => p.id === s.livePanel?.panelId));
  const agent = useStore((s) => s.agents.find((a) => a.id === s.livePanel?.agentId));
  if (!live || !panel) return null;
  return (
    <div className="live-dock" key={panel.id}>
      <div className="live-dock-bar">
        {agent?.status === "working" && <span className="live-dot" />}
        <span>
          {agent ? (agent.status === "working" ? `${agent.name} está trabajando en` : `${agent.name} ha actualizado`) : "En vivo:"}{" "}
          <strong>{panel.title}</strong>
        </span>
        <span style={{ flex: 1 }} />
        <Link href="/paneles" className="btn ghost small">
          Ver todos
        </Link>
        <button className="icon-btn small" onClick={closeLivePanel} aria-label="Cerrar">
          ×
        </button>
      </div>
      <PanelCard panel={panel} compact />
    </div>
  );
}
