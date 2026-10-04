"use client";

import { useCallback, useEffect, useState } from "react";
import { api, onEvent } from "@/client/store";
import type { CodeChange } from "@/lib/dev/workspace";
import { Backdrop } from "./Backdrop";
import { Markdown } from "./Markdown";

const STATUS: Record<string, string> = {
  pendiente: "Pendiente de revisar",
  validando: "Validando…",
  aplicada: "Aplicada",
  descartada: "Descartada",
  error: "No se pudo aplicar",
};

function DiffView({ id, onClose }: { id: string; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    api<{ diff: string }>(`/api/code-changes/${id}/diff`).then((r) => setDiff(r.diff));
  }, [id]);
  return (
    <Backdrop onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Cambios propuestos</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </header>
        <pre className="diff">
          {diff === null
            ? "Cargando…"
            : diff.split("\n").map((l, i) => (
                <span
                  key={i}
                  className={
                    l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ")
                      ? "d-file"
                      : l.startsWith("@@")
                        ? "d-hunk"
                        : l.startsWith("+")
                          ? "d-add"
                          : l.startsWith("-")
                            ? "d-del"
                            : ""
                  }
                >
                  {l}
                  {"\n"}
                </span>
              ))}
        </pre>
      </div>
    </Backdrop>
  );
}

/** Propuesta de cambios de código de un agente admin: revisar, aplicar o descartar. */
export function CodeChangeCard({ agentId }: { agentId: string }) {
  const [change, setChange] = useState<CodeChange | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const list = await api<CodeChange[]>(`/api/code-changes?agentId=${agentId}`).catch(() => []);
    // La abierta, o la última si se aplicó/descartó hace poco.
    const open = list.find((c) => ["pendiente", "validando", "error"].includes(c.status));
    const recent = list[0] && Date.now() - Date.parse(list[0].updatedAt) < 10 * 60_000 ? list[0] : null;
    setChange(open ?? recent ?? null);
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "code.updated" && (e.payload as CodeChange).agentId === agentId) setChange(e.payload as CodeChange);
      }),
    [agentId],
  );

  if (!change || (!change.files.length && change.status === "pendiente")) return null;
  const act = (action: "apply" | "discard") => {
    setError("");
    api(`/api/code-changes/${change.id}`, { method: "POST", json: { action } }).catch((e) => setError(e.message));
  };
  const added = change.files.reduce((s, f) => s + f.added, 0);
  const removed = change.files.reduce((s, f) => s + f.removed, 0);
  const open = change.status === "pendiente" || change.status === "error";

  return (
    <section className={`code-card s-${change.status}`}>
      <header>
        <span className="code-icon">{"</>"}</span>
        <strong>{STATUS[change.status]}</strong>
        <span className="muted small">
          {change.files.length} archivo(s) · <span className="d-add">+{added}</span> <span className="d-del">−{removed}</span>
        </span>
      </header>
      <ul className="code-files">
        {change.files.slice(0, 8).map((f) => (
          <li key={f.path}>
            <code>{f.path}</code>
            <span className="d-add">+{f.added}</span>
            <span className="d-del">−{f.removed}</span>
          </li>
        ))}
        {change.files.length > 8 && <li className="muted">y {change.files.length - 8} más…</li>}
      </ul>
      {change.summary && (
        <details className="code-summary">
          <summary>Resumen del agente</summary>
          <Markdown text={change.summary} />
        </details>
      )}
      {change.log && (
        <details className="code-log" open={change.status !== "pendiente" && showLog !== false} onToggle={(e) => setShowLog((e.target as HTMLDetailsElement).open)}>
          <summary>Validación</summary>
          <pre>{change.log}</pre>
        </details>
      )}
      <div className="row">
        <button className="btn ghost small" onClick={() => setShowDiff(true)} disabled={!change.files.length}>
          Ver cambios
        </button>
        <span style={{ flex: 1 }} />
        {open && (
          <>
            <button className="btn ghost small danger" onClick={() => confirm("¿Descartar estos cambios? Se perderán.") && act("discard")}>
              Descartar
            </button>
            <button className="btn primary small" onClick={() => act("apply")}>
              {change.status === "error" ? "Reintentar" : "Aplicar y reiniciar"}
            </button>
          </>
        )}
        {change.status === "validando" && <span className="spinner" />}
      </div>
      {open && <p className="hint">Antes de aplicar se comprueban los tipos, los tests y la compilación en su copia. Si algo falla, la app no se toca.</p>}
      {error && <p className="bad-text small">{error}</p>}
      {showDiff && <DiffView id={change.id} onClose={() => setShowDiff(false)} />}
    </section>
  );
}
