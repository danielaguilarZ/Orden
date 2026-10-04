"use client";

import { Backdrop } from "../Backdrop";
import { useState } from "react";
import type { KanbanCard, KanbanData } from "@/lib/panels/types";
import { AddInput, InlineText, useFresh, type PanelViewProps } from "./common";

const PRIORITY: Record<string, string> = { alta: "Alta", media: "Media", baja: "Baja" };

function CardEditor({ card, onSave, onDelete, onClose }: { card: KanbanCard; onSave: (c: Partial<KanbanCard>) => void; onDelete: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes ?? "");
  const [due, setDue] = useState(card.due ?? "");
  const [priority, setPriority] = useState(card.priority ?? "");
  const [tags, setTags] = useState((card.tags ?? []).join(", "));
  return (
    <Backdrop onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            title,
            notes: notes || undefined,
            due: due || undefined,
            priority: (priority || undefined) as KanbanCard["priority"],
            tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          });
        }}
      >
        <header className="modal-head">
          <h2>Tarjeta</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="form-col">
          <label>
            Título
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Notas
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="row">
            <label>
              Fecha límite
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label>
              Prioridad
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">—</option>
                <option value="alta">Alta</option>
                <option value="media">Media</option>
                <option value="baja">Baja</option>
              </select>
            </label>
          </div>
          <label>
            Etiquetas (separadas por comas)
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn danger" onClick={onDelete} style={{ marginRight: "auto" }}>
            Borrar
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary">Guardar</button>
        </footer>
      </form>
    </Backdrop>
  );
}

export function KanbanView({ panel, run, compact }: PanelViewProps<KanbanData>) {
  const { columns } = panel.data;
  const fresh = useFresh(columns.flatMap((c) => c.cards.map((k) => k.id)));
  const [editing, setEditing] = useState<KanbanCard | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  return (
    <div className={`kanban ${compact ? "compact" : ""}`}>
      {columns.map((col) => (
        <section
          key={col.id}
          className={`kb-col ${dragOver === col.id ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(col.id);
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const id = e.dataTransfer.getData("text/card");
            if (id) run([{ op: "move_card", id, column: col.id }]);
          }}
        >
          <header>
            <InlineText value={col.title} onSave={(title) => run([{ op: "rename_column", column: col.id, title }])} className="kb-title" />
            <span className="kb-count">{col.cards.length}</span>
            {!compact && (
              <button
                className="icon-btn small"
                title="Quitar columna"
                onClick={() => confirm(`¿Quitar la columna «${col.title}» y sus tarjetas?`) && run([{ op: "remove_column", column: col.id }])}
              >
                ×
              </button>
            )}
          </header>
          <div className="kb-cards">
            {col.cards.map((card) => (
              <article
                key={card.id}
                className={`kb-card ${fresh.has(card.id) ? "fresh" : ""}`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/card", card.id)}
                onClick={() => setEditing(card)}
              >
                <span className="kb-card-title">{card.title}</span>
                {(card.due || card.priority || card.tags?.length) && (
                  <span className="kb-meta">
                    {card.priority && <span className={`prio p-${card.priority}`}>{PRIORITY[card.priority]}</span>}
                    {card.due && <span className="due">{card.due}</span>}
                    {card.tags?.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </article>
            ))}
          </div>
          {!compact && <AddInput placeholder="+ Tarjeta" onAdd={(title) => run([{ op: "add_card", column: col.id, title }])} />}
        </section>
      ))}
      {!compact && (
        <section className="kb-col kb-new">
          <AddInput placeholder="+ Columna" onAdd={(title) => run([{ op: "add_column", title }])} />
        </section>
      )}
      {editing && (
        <CardEditor
          card={editing}
          onClose={() => setEditing(null)}
          onDelete={() => {
            run([{ op: "remove_card", id: editing.id }]);
            setEditing(null);
          }}
          onSave={(c) => {
            run([{ op: "update_card", id: editing.id, ...c }]);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
