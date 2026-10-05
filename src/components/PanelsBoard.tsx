"use client";

import { Backdrop } from "./Backdrop";
import { useEffect, useMemo, useState } from "react";
import { api, useStore } from "@/client/store";
import { panelTemplates, TYPE_INFO, typeName, type PanelTemplate } from "@/lib/panels/templates";
import type { Panel } from "@/lib/repo/panels";
import { PanelCard } from "./panels/PanelCard";
import { MoreMenu } from "./panels/MoreMenu";
import { PanelsTabs } from "./PanelsTabs";

/** Hoy en hora local (AAAA-MM-DD). */
const todayLocal = () => new Intl.DateTimeFormat("sv-SE").format(new Date());

function createFromTemplate(t: PanelTemplate) {
  return api("/api/panels", { method: "POST", json: { type: t.type, title: t.title, data: t.data } });
}

/** Rejilla de plantillas: un clic y el panel está creado. */
function TemplateGrid({ onCreated }: { onCreated?: () => void }) {
  const templates = useMemo(() => panelTemplates(todayLocal()), []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  return (
    <>
      <div className="tpl-grid">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tpl-card"
            disabled={Boolean(busy)}
            onClick={async () => {
              setBusy(t.id);
              setError("");
              try {
                await createFromTemplate(t);
                onCreated?.();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy("");
              }
            }}
          >
            <span className="tpl-icon">{TYPE_INFO[t.type]?.icon ?? "▢"}</span>
            <strong>{busy === t.id ? "Creando…" : t.name}</strong>
            <small>{t.hint}</small>
          </button>
        ))}
      </div>
      {error && <p className="bad-text small">{error}</p>}
    </>
  );
}

function NewPanel({ onClose }: { onClose: () => void }) {
  const [blank, setBlank] = useState(false);
  const [type, setType] = useState("lista");
  const [title, setTitle] = useState("");
  return (
    <Backdrop onClick={onClose}>
      <div className="modal new-panel" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Nuevo panel</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>
        {!blank ? (
          <>
            <p className="muted small">Elige una plantilla para empezar. Podrás cambiar el nombre y el contenido cuando quieras.</p>
            <TemplateGrid onCreated={onClose} />
            <footer className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setBlank(true)}>
                Empezar en blanco
              </button>
            </footer>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await api("/api/panels", { method: "POST", json: { type, title: title.trim() || typeName(type) } });
              onClose();
            }}
          >
            <p className="muted small">¿Qué tipo de panel?</p>
            <div className="type-list" role="radiogroup">
              {Object.entries(TYPE_INFO).map(([key, info]) => (
                <button type="button" key={key} role="radio" aria-checked={type === key} className={type === key ? "on" : ""} onClick={() => setType(key)}>
                  <span className="tpl-icon">{info.icon}</span>
                  <strong>{info.name}</strong>
                  <small>{info.hint}</small>
                </button>
              ))}
            </div>
            <label className="form-col">
              Nombre
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={typeName(type)} />
            </label>
            <footer className="modal-foot">
              <button type="button" className="btn ghost" onClick={() => setBlank(false)}>
                Volver a plantillas
              </button>
              <button className="btn primary">Crear panel</button>
            </footer>
          </form>
        )}
      </div>
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
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>
        {items?.length === 0 && <p className="muted">La papelera está vacía.</p>}
        <ul className="versions">
          {items?.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.title}</strong>
                <small>
                  {typeName(p.type)} · {new Date(p.updatedAt).toLocaleString("es-ES")}
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

/**
 * Tablero de paneles. Una sola acción principal («Nuevo panel»); lo demás
 * (exportar, papelera) va en «Más». Los paneles se reordenan arrastrando por
 * la cabecera.
 */
export function PanelsBoard() {
  const panels = useStore((s) => s.panels);
  const [modal, setModal] = useState<"new" | "trash" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

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
        <span style={{ flex: 1 }} />
        {notice && <span className="ok-text small">{notice}</span>}
        <MoreMenu
          label="Más"
          title="Exportar y papelera"
          className="btn ghost"
          items={[
            {
              label: "Exportar todos los paneles",
              disabled: !panels.length,
              onClick: () =>
                api<{ dir: string; files: string[] }>("/api/exports", { method: "POST", json: { action: "all" } }).then((r) =>
                  setNotice(`${r.files.length} archivos guardados en ${r.dir}`),
                ),
            },
            { label: "Abrir la carpeta de exportaciones", onClick: () => api("/api/exports", { method: "POST", json: { action: "open" } }) },
            { label: "Papelera", onClick: () => setModal("trash") },
          ]}
        />
        <button className="btn primary" onClick={() => setModal("new")}>
          + Nuevo panel
        </button>
      </div>
      {panels.length === 0 ? (
        <div className="board-welcome">
          <h2>Crea tu primer panel</h2>
          <p className="muted">
            Un panel es una lista, un calendario, una tabla… que tú y los agentes mantenéis al día. Empieza con una plantilla o pídeselo a Zen desde el Living, por
            ejemplo: <em>«créame un calendario con mis tareas de esta semana»</em>.
          </p>
          <TemplateGrid />
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
