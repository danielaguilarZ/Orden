"use client";

import { useState } from "react";
import type { ListData } from "@/lib/panels/types";
import { AddInput, InlineText, useFresh, type PanelViewProps } from "./common";

export function ListView({ panel, run, compact }: PanelViewProps<ListData>) {
  const { items, checkable } = panel.data;
  const fresh = useFresh(items.map((i) => i.id));
  const [drag, setDrag] = useState<string | null>(null);
  const done = items.filter((i) => i.done).length;

  return (
    <div className="plist">
      {checkable && items.length > 0 && (
        <div className="progress" title={`${done} de ${items.length}`}>
          <span style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      )}
      <ul>
        {items.map((it, index) => (
          <li
            key={it.id}
            className={`${it.done ? "done" : ""} ${fresh.has(it.id) ? "fresh" : ""}`}
            draggable={!compact}
            onDragStart={() => setDrag(it.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (drag && drag !== it.id) run([{ op: "move_item", id: drag, index }]);
              setDrag(null);
            }}
          >
            {checkable && (
              <input type="checkbox" checked={it.done} onChange={() => run([{ op: "toggle_item", id: it.id }])} aria-label="Hecho" />
            )}
            <div className="plist-text">
              <InlineText value={it.text} onSave={(text) => run([{ op: "update_item", id: it.id, text }])} />
              {(it.notes || it.due) && !compact && (
                <small>
                  {it.due && <span className="due">{it.due}</span>} {it.notes}
                </small>
              )}
            </div>
            {!compact && (
              <button className="icon-btn small" onClick={() => run([{ op: "remove_item", id: it.id }])} aria-label="Quitar">
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!compact && <AddInput placeholder="+ Añadir" onAdd={(text) => run([{ op: "add_item", text }])} />}
    </div>
  );
}
