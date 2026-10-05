"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, patchPanelLocal } from "@/client/store";
import { applyOp, type OpInput } from "@/lib/panels/types";
import type { Panel } from "@/lib/repo/panels";

export interface PanelViewProps<D> {
  panel: Panel & { data: D };
  /** Aplica operaciones (optimista + servidor). */
  run: (ops: OpInput[]) => void;
  compact?: boolean;
}

/** Edita con las mismas operaciones que los agentes: local al instante, servidor después. */
export function usePanelOps(panel: Panel) {
  const [error, setError] = useState("");
  const run = useCallback(
    (ops: OpInput[]) => {
      setError("");
      try {
        let data = panel.data;
        for (const o of ops) data = applyOp(panel.type, data, o);
        patchPanelLocal({ ...panel, data });
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      api(`/api/panels/${panel.id}`, { method: "PATCH", json: { ops } }).catch((err) => setError(err.message));
    },
    [panel],
  );
  return { run, error };
}

export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/** Ids que han aparecido después de montar (para resaltarlos al llegar). */
export function useFresh(ids: string[]): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const key = ids.join("|");
  useEffect(() => {
    if (!known.current) {
      known.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !known.current!.has(id));
    ids.forEach((id) => known.current!.add(id));
    if (!added.length) return;
    setFresh((f) => new Set([...f, ...added]));
    const t = setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fresh;
}

/** Texto editable al hacer clic. */
export function InlineText({
  value,
  onSave,
  className,
  placeholder,
  multiline,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing)
    return (
      <span className={`inline-text ${className ?? ""} ${value ? "" : "empty"}`} onClick={() => setEditing(true)} title="Clic para editar">
        {value || placeholder || "—"}
      </span>
    );
  const done = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };
  const props = {
    autoFocus: true,
    value: draft,
    className: `inline-input ${className ?? ""}`,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: done,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (!multiline || e.ctrlKey)) done();
      if (e.key === "Escape") {
        setDraft(value);
        setEditing(false);
      }
    },
  };
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} />;
}

/** Campo para añadir elementos con Enter. */
export function AddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="add-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onAdd(v.trim());
        setV("");
      }}
    >
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} />
    </form>
  );
}

export const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseLocal(s: string): Date {
  const [date, time] = s.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time ?? "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}
