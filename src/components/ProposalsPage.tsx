"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import {
  byPriority,
  findHumanActionPanel,
  PRIORITIES,
  SCOPE_KEYS,
  SCOPES,
  STATUS_LABEL,
  TAB_LABEL,
  viewOf,
  type Decision,
  type Proposal,
  type ProposalPriority,
  type ProposalScope,
  type ProposalView,
} from "@/lib/proposals/labels";
import { Markdown } from "./Markdown";
import { useMounted } from "./panels/common";
import { PanelCard } from "./panels/PanelCard";

const VIEWS: { key: ProposalView; label: string; hint: string }[] = [
  { key: "decidir", label: "Por decidir", hint: "Acepta, rechaza o deja para más tarde." },
  { key: "marcha", label: "En marcha", hint: "Aceptadas: Zen las ejecuta con permisos completos." },
  { key: "aplazadas", label: "Aplazadas", hint: "Vuelven a «Por decidir» cuando llegue su fecha." },
  { key: "historico", label: "Histórico", hint: "Hechas y rechazadas (con su motivo)." },
];

const POSTPONE: { days: number; label: string }[] = [
  { days: 1, label: "Mañana" },
  { days: 7, label: "1 semana" },
  { days: 30, label: "1 mes" },
];

const date = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

/**
 * Pestaña «Acción humana» (antes «Propuestas»): arriba, el panel con lo que el
 * equipo necesita del usuario; debajo, las propuestas que él acepta, rechaza o aplaza.
 */
export function ProposalsPage() {
  const humanPanel = useStore((s) => findHumanActionPanel(s.panels));
  const [list, setList] = useState<Proposal[] | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<ProposalView>("decidir");
  const [scope, setScope] = useState<ProposalScope | "">("");
  const [priority, setPriority] = useState<ProposalPriority | "">("");
  const mounted = useMounted();

  const load = useCallback(
    () =>
      api<{ proposals: Proposal[] }>("/api/proposals").then(
        (d) => {
          setList(d.proposals);
          setError("");
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    load();
    return onEvent((e) => {
      if (e.type.startsWith("proposal.")) load();
    });
  }, [load]);

  // La lista solo se carga en el navegador: «ahora» se recalcula con cada carga.
  const at = useMemo(() => new Date(), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const c: Record<ProposalView, number> = { decidir: 0, marcha: 0, aplazadas: 0, historico: 0 };
    for (const p of list ?? []) c[viewOf(p, at)]++;
    return c;
  }, [list, at]);
  const shown = useMemo(
    () =>
      (list ?? [])
        .filter((p) => viewOf(p, at) === view)
        .filter((p) => !scope || p.scope === scope)
        .filter((p) => !priority || p.priority === priority)
        .sort(view === "historico" ? (a, b) => (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt) : byPriority),
    [list, at, view, scope, priority],
  );

  const decide = async (p: Proposal, accion: Decision, extra: { motivo?: string; dias?: number } = {}) => {
    setError("");
    try {
      await api(`/api/proposals/${p.id}`, { method: "POST", json: { accion, ...extra } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="board proposals">
      <div className="board-bar">
        <h1>{TAB_LABEL}</h1>
        <span className="muted">Lo que el equipo necesita de ti y sus propuestas. Al aceptar una, Zen se pone con ella.</span>
      </div>

      {humanPanel && (
        <section className="human-action">
          <PanelCard panel={humanPanel} />
        </section>
      )}

      <h2 className="prop-section">Propuestas</h2>
      <div className="prop-bar">
        <div className="seg prop-views">
          {VIEWS.map((v) => (
            <button key={v.key} className={view === v.key ? "on" : ""} title={v.hint} onClick={() => setView(v.key)}>
              {v.label} <span className="prop-count">{counts[v.key]}</span>
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <select value={scope} onChange={(e) => setScope(e.target.value as ProposalScope | "")} aria-label="Ámbito">
          <option value="">Todos los ámbitos</option>
          {SCOPE_KEYS.map((k) => (
            <option key={k} value={k}>
              {SCOPES[k]}
            </option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as ProposalPriority | "")} aria-label="Prioridad">
          <option value="">Toda prioridad</option>
          {PRIORITIES.map((k) => (
            <option key={k} value={k}>
              Prioridad {k}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">{VIEWS.find((v) => v.key === view)!.hint}</p>

      {error && <p className="bad-text">{error}</p>}
      {!list && !error && <p className="muted">Cargando…</p>}
      {list && !shown.length && (
        <p className="muted prop-empty">
          {view === "decidir" && !scope && !priority ? "No hay nada por decidir. Zen propone cada mañana." : "No hay propuestas aquí con estos filtros."}
        </p>
      )}
      <div className="prop-grid">
        {shown.map((p) => (
          <ProposalCard key={p.id} p={p} view={view} mounted={mounted} onDecide={(a, x) => decide(p, a, x)} />
        ))}
      </div>
    </div>
  );
}

function ProposalCard({
  p,
  view,
  mounted,
  onDecide,
}: {
  p: Proposal;
  view: ProposalView;
  mounted: boolean;
  onDecide: (a: Decision, extra?: { motivo?: string; dias?: number }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"" | "rechazar" | "aplazar">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (a: Decision, extra?: { motivo?: string; dias?: number }) => {
    setBusy(true);
    try {
      await onDecide(a, extra);
    } finally {
      setBusy(false);
      setMode("");
    }
  };
  const pending = p.status === "pendiente";

  return (
    <article className={`prop-card st-${p.status}`}>
      <header className="prop-head">
        <h2>{p.title}</h2>
        <span className={`prop-status st-${p.status}`}>{STATUS_LABEL[p.status]}</span>
      </header>
      <div className="prop-tags">
        <span className="tag">{SCOPES[p.scope]}</span>
        <span className={`tag prio-${p.priority}`}>Prioridad {p.priority}</span>
        <span className="tag">Impacto {p.impact}</span>
        <span className="tag">Esfuerzo {p.effort}</span>
      </div>
      {p.description && (
        <div className="prop-desc">
          <Markdown text={p.description} />
        </div>
      )}
      {p.rejectReason && (
        <p className="prop-note bad">
          <strong>Motivo del rechazo:</strong> {p.rejectReason}
        </p>
      )}
      {p.resultNote && (
        <div className="prop-note ok">
          <strong>Resultado:</strong> <Markdown text={p.resultNote} />
        </div>
      )}
      {p.status === "aceptada" && <p className="prop-note small muted">{p.taskId ? "Zen ya tiene el encargo." : "Se avisará a Zen en unos segundos."}</p>}
      <footer className="prop-foot">
        <span className="muted small">
          {p.authorName} · {mounted ? date(p.createdAt) : p.createdAt.slice(0, 10)}
          {view === "aplazadas" && p.postponedUntil && mounted && <> · aplazada hasta {date(p.postponedUntil)}</>}
          {view === "historico" && (p.finishedAt ?? p.decidedAt) && mounted && (
            <>
              {" "}
              · {p.status === "hecha" ? "hecha" : "decidida"} el {date((p.finishedAt ?? p.decidedAt)!)}
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {pending && mode === "" && (
          <>
            <button className="btn small ghost" disabled={busy} onClick={() => setMode("aplazar")}>
              Más tarde
            </button>
            <button className="btn small danger" disabled={busy} onClick={() => setMode("rechazar")}>
              Rechazar
            </button>
            <button className="btn small primary" disabled={busy} onClick={() => run("aceptar")}>
              Aceptar
            </button>
          </>
        )}
        {p.status === "rechazada" && (
          <button className="btn small ghost" disabled={busy} onClick={() => run("reabrir")} title="Vuelve a «Por decidir»">
            Recuperar
          </button>
        )}
      </footer>

      {mode === "aplazar" && (
        <div className="prop-action">
          <span className="small muted">¿Hasta cuándo?</span>
          <div className="seg">
            {POSTPONE.map((o) => (
              <button key={o.days} disabled={busy} onClick={() => run("aplazar", { dias: o.days })}>
                {o.label}
              </button>
            ))}
          </div>
          <button className="btn small ghost" onClick={() => setMode("")}>
            Cancelar
          </button>
        </div>
      )}
      {mode === "rechazar" && (
        <form
          className="prop-action"
          onSubmit={(e) => {
            e.preventDefault();
            run("rechazar", { motivo: reason.trim() || undefined });
          }}
        >
          <input autoFocus value={reason} maxLength={500} placeholder="Motivo (opcional): ayuda a Zen a proponer mejor" onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn small ghost" onClick={() => setMode("")}>
            Cancelar
          </button>
          <button className="btn small danger" disabled={busy}>
            Rechazar
          </button>
        </form>
      )}
    </article>
  );
}
