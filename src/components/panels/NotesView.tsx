"use client";

import { useState } from "react";
import type { NotesData } from "@/lib/panels/types";
import { Markdown } from "../Markdown";
import type { PanelViewProps } from "./common";

export function NotesView({ panel, run, compact }: PanelViewProps<NotesData>) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null)
    return (
      <div className="pnotes editing">
        <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} />
        <div className="row end">
          <button className="btn ghost small" onClick={() => setDraft(null)}>
            Cancelar
          </button>
          <button
            className="btn primary small"
            onClick={() => {
              run([{ op: "set_text", markdown: draft }]);
              setDraft(null);
            }}
          >
            Guardar
          </button>
        </div>
      </div>
    );
  return (
    <div className="pnotes" onDoubleClick={() => !compact && setDraft(panel.data.markdown)}>
      {panel.data.markdown ? <Markdown text={panel.data.markdown} /> : <p className="muted">Sin notas todavía.</p>}
      {!compact && (
        <button className="btn ghost small pnotes-edit" onClick={() => setDraft(panel.data.markdown)}>
          Editar
        </button>
      )}
    </div>
  );
}
