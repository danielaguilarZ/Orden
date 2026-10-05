"use client";

import { useState } from "react";
import { tableTotals, type TableColumn, type TableData } from "@/lib/panels/types";
import { useFresh, type PanelViewProps } from "./common";

const TYPES: TableColumn["type"][] = ["texto", "numero", "moneda", "fecha", "si/no", "porcentaje"];

export function formatCell(value: unknown, col: TableColumn, currency: string): string {
  if (value === null || value === undefined || value === "") return "";
  switch (col.type) {
    case "moneda":
      return Number.isFinite(Number(value)) ? new Intl.NumberFormat("es-ES", { style: "currency", currency }).format(Number(value)) : String(value);
    case "numero":
      return Number.isFinite(Number(value)) ? new Intl.NumberFormat("es-ES").format(Number(value)) : String(value);
    case "porcentaje":
      return Number.isFinite(Number(value)) ? `${new Intl.NumberFormat("es-ES").format(Number(value))} %` : String(value);
    case "si/no":
      return value === true || value === "true" || value === "sí" ? "Sí" : "No";
    default:
      return String(value);
  }
}

function parseCell(raw: string, col: TableColumn): string | number | boolean | null {
  if (raw.trim() === "") return null;
  if (["numero", "moneda", "porcentaje"].includes(col.type)) {
    const n = Number(raw.replace(/\s|€|%/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : raw;
  }
  if (col.type === "si/no") return /^(s|si|sí|true|1|x)$/i.test(raw.trim());
  return raw;
}

function Cell({ value, col, currency, onSave }: { value: unknown; col: TableColumn; currency: string; onSave: (v: string | number | boolean | null) => void }) {
  const [editing, setEditing] = useState(false);
  if (col.type === "si/no")
    return (
      <td className="t-bool">
        <input type="checkbox" checked={value === true} onChange={(e) => onSave(e.target.checked)} />
      </td>
    );
  const numeric = ["numero", "moneda", "porcentaje"].includes(col.type);
  if (!editing)
    return (
      <td className={numeric ? "num" : ""} onClick={() => setEditing(true)}>
        {formatCell(value, col, currency)}
      </td>
    );
  return (
    <td className="editing">
      <input
        autoFocus
        type={col.type === "fecha" ? "date" : "text"}
        defaultValue={value === null || value === undefined ? "" : String(value)}
        onBlur={(e) => {
          setEditing(false);
          const v = parseCell(e.target.value, col);
          if (v !== value) onSave(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    </td>
  );
}

export function TableView({ panel, run, compact }: PanelViewProps<TableData>) {
  const { columns, rows, currency } = panel.data;
  const fresh = useFresh(rows.map((r) => r.id));
  const totals = tableTotals(panel.data);
  const hasTotals = Object.keys(totals).length > 0;
  const [newCol, setNewCol] = useState<{ label: string; type: TableColumn["type"] } | null>(null);

  return (
    <div className="ptable">
      <div className="ptable-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={["numero", "moneda", "porcentaje"].includes(c.type) ? "num" : ""}>
                  {c.label}
                  {!compact && (
                    <button
                      className="th-x"
                      title="Quitar columna"
                      onClick={() => confirm(`¿Quitar la columna «${c.label}»?`) && run([{ op: "remove_column", key: c.key }])}
                    >
                      ×
                    </button>
                  )}
                </th>
              ))}
              {!compact && <th className="th-actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={fresh.has(r.id) ? "fresh" : ""}>
                {columns.map((c) => (
                  <Cell key={c.key} value={r.cells[c.key]} col={c} currency={currency} onSave={(v) => run([{ op: "update_row", id: r.id, cells: { [c.key]: v } }])} />
                ))}
                {!compact && (
                  <td className="row-x">
                    <button className="icon-btn small" onClick={() => run([{ op: "remove_row", id: r.id }])} aria-label="Quitar fila">
                      ×
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {hasTotals && (
            <tfoot>
              <tr>
                {columns.map((c, i) => (
                  <td key={c.key} className={c.key in totals ? "num" : ""}>
                    {c.key in totals ? formatCell(totals[c.key], c, currency) : i === 0 ? "Total" : ""}
                  </td>
                ))}
                {!compact && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {!compact && (
        <div className="ptable-actions">
          <button className="btn ghost small" onClick={() => run([{ op: "add_row", cells: {} }])}>
            + Fila
          </button>
          {newCol ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newCol.label.trim()) return;
                const key = newCol.label
                  .toLowerCase()
                  .normalize("NFD")
                  .replace(/[̀-ͯ]/g, "")
                  .replace(/[^a-z0-9]+/g, "_");
                run([{ op: "add_column", key, label: newCol.label.trim(), type: newCol.type, total: ["numero", "moneda"].includes(newCol.type) }]);
                setNewCol(null);
              }}
            >
              <input autoFocus placeholder="Nombre de la columna" value={newCol.label} onChange={(e) => setNewCol({ ...newCol, label: e.target.value })} />
              <select value={newCol.type} onChange={(e) => setNewCol({ ...newCol, type: e.target.value as TableColumn["type"] })}>
                {TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <button className="btn small">Añadir</button>
            </form>
          ) : (
            <button className="btn ghost small" onClick={() => setNewCol({ label: "", type: "texto" })}>
              + Columna
            </button>
          )}
        </div>
      )}
    </div>
  );
}
