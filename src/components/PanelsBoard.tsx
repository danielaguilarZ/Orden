"use client";

import { Backdrop } from "./Backdrop";
import { useEffect, useState } from "react";
import { api, useStore } from "@/client/store";
import { PANEL_TYPES } from "@/lib/panels/types";
import type { Panel } from "@/lib/repo/panels";
import { PanelCard, PANEL_ICONS } from "./panels/PanelCard";
import { PanelsTabs } from "./PanelsTabs";

function NewPanel({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState("lista");
  const [title, setTitle] = useState("");
  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          await api("/api/panels", { method: "POST", json: { type, title } });
          onClose();
        }}
      >
        <header className="modal-head">
          <h2>Nuevo panel</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="type-grid">
          {Object.values(PANEL_TYPES).map((t) => (
            <button type="button" key={t.type} className={type === t.type ? "on" : ""} onClick={() => setType(t.type)}>
              <span>{PANEL_ICONS[t.type]}</span>
              {t.label}
            </button>
          ))}
        </div>
        <label className="form-col">
          Título
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={PANEL_TYPES[type].label} />
        </label>
        <footer className="modal-foot">
          <button className="btn primary">Crear</button>
        </footer>
      </form>
    </Backdrop>
  );
}

function Trash({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Panel[] | null>(null);
  const load = () => api<Panel[]>("/api/panels?archived=1").then(setItems);
  useEffect(() => {
    load();
  }, []);
  return (
    <Backdrop onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Papelera</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        {items?.length === 0 && <p className="muted">Vacía.</p>}
        <ul className="versions">
          {items?.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.title}</strong>
                <small>
                  {PANEL_TYPES[p.type]?.label} · {new Date(p.updatedAt).toLocaleString("es-ES")}
                </small>
              </div>
              <div className="row">
                <button className="btn small" onClick={() => api(`/api/panels/${p.id}/restore`, { method: "POST" }).then(load)}>
                  Recuperar
                </button>
                <button
                  className="btn danger small"
                  onClick={() => confirm(`¿Borrar «${p.title}» para siempre?`) && api(`/api/panels/${p.id}?forever=1`, { method: "DELETE" }).then(load)}
                >
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Backdrop>
  );
}

/** Tablero de paneles: se reordenan arrastrando por la cabecera. */
export function PanelsBoard() {
  const panels = useStore((s) => s.panels);
  const [modal, setModal] = useState<"new" | "trash" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [exported, setExported] = useState("");

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = panels.map((p) => p.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    api("/api/panels/reorder", { method: "POST", json: { ids } });
  };

  return (
    <div className="board">
      <div className="board-bar">
        <h1>Paneles</h1>
        <PanelsTabs active="tablero" />
        <span className="muted">Lo que crean los agentes, en vivo. Edítalos a mano o pide cambios.</span>
        <span style={{ flex: 1 }} />
        {exported && <span className="ok-text small">{exported}</span>}
        <button
          className="btn ghost"
          disabled={!panels.length}
          onClick={() =>
            api<{ dir: string; files: string[] }>("/api/exports", { method: "POST", json: { action: "all" } }).then((r) =>
              setExported(`${r.files.length} archivos en ${r.dir}`),
            )
          }
        >
          Exportar todo
        </button>
        <button className="btn ghost" onClick={() => api("/api/exports", { method: "POST", json: { action: "open" } })}>
          Abrir carpeta
        </button>
        <button className="btn ghost" onClick={() => setModal("trash")}>
          Papelera
        </button>
        <button className="btn primary" onClick={() => setModal("new")}>
          + Nuevo panel
        </button>
      </div>
      {panels.length === 0 ? (
        <div className="board-empty">
          <p>Todavía no hay paneles.</p>
          <p className="muted">Pídele a Zen algo como «créame un calendario con mis tareas de esta semana» y verás cómo se construye aquí.</p>
        </div>
      ) : (
        <div className="board-grid">
          {panels.map((p) => (
            <div
              key={p.id}
              className={`board-cell size-${p.layout.size ?? "normal"} ${overId === p.id ? "drop-target" : ""} ${dragId === p.id ? "dragging" : ""}`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverId(p.id);
              }}
              onDragLeave={() => setOverId(null)}
              onDrop={(e) => {
                e.preventDefault();
                drop(p.id);
                setDragId(null);
                setOverId(null);
              }}
            >
              <PanelCard
                panel={p}
                dragHandle={{
                  draggable: true,
                  onDragStart: (e) => {
                    e.dataTransfer.setData("text/panel", p.id);
                    setDragId(p.id);
                  },
                  onDragEnd: () => setDragId(null),
                }}
              />
            </div>
          ))}
        </div>
      )}
      {modal === "new" && <NewPanel onClose={() => setModal(null)} />}
      {modal === "trash" && <Trash onClose={() => setModal(null)} />}
    </div>
  );
}
