"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, onEvent } from "@/client/store";
import { answerLabel, byOldest, byResolved, MAX_ANSWER_LENGTH, TAB_LABEL, viewOf, type Decision, type DecisionAction } from "@/lib/decisions/labels";
import { Markdown } from "./Markdown";
import { useMounted } from "./panels/common";

const POSTPONE: { days: number; label: string }[] = [
  { days: 1, label: "Mañana" },
  { days: 7, label: "1 semana" },
  { days: 30, label: "1 mes" },
];

const date = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

type Act = (d: Decision, accion: DecisionAction, extra?: { respuesta?: string; opcion?: string; dias?: number }) => Promise<void>;

/**
 * Pestaña «Decisiones»: solo lo que el usuario tiene que decidir. Cada
 * decisión se responde con texto, con una opción sugerida o con
 * aceptar/rechazar; la respuesta le llega al agente que la planteó.
 * Aplazadas y resueltas quedan plegadas debajo.
 */
export function DecisionsPage() {
  const [list, setList] = useState<Decision[] | null>(null);
  const [error, setError] = useState("");
  const mounted = useMounted();

  const load = useCallback(
    () =>
      api<{ decisions: Decision[] }>("/api/decisions").then(
        (d) => {
          setList(d.decisions);
          setError("");
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    load();
    return onEvent((e) => {
      if (e.type.startsWith("decision.")) load();
    });
  }, [load]);

  // La lista solo se carga en el navegador: «ahora» se recalcula con cada carga.
  const at = useMemo(() => new Date(), [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const all = list ?? [];
    return {
      pending: all.filter((d) => viewOf(d, at) === "pendientes").sort(byOldest),
      postponed: all.filter((d) => viewOf(d, at) === "aplazadas").sort(byOldest),
      resolved: all.filter((d) => viewOf(d, at) === "resueltas").sort(byResolved),
    };
  }, [list, at]);

  const act: Act = async (d, accion, extra = {}) => {
    setError("");
    try {
      await api(`/api/decisions/${d.id}`, { method: "POST", json: { accion, ...extra } });
      await load();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };

  return (
    <div className="board decisions">
      <div className="board-bar">
        <h1>{TAB_LABEL}</h1>
        <span className="muted">Lo que el equipo necesita que decidas. Tu respuesta le llega al agente que lo preguntó.</span>
      </div>

      {error && <p className="bad-text">{error}</p>}
      {!list && !error && <p className="muted">Cargando…</p>}
      {list && !groups.pending.length && (
        <div className="dec-empty">
          <strong>Todo al día</strong>
          <p className="muted">No tienes nada pendiente. Cuando un agente necesite algo de ti, aparecerá aquí.</p>
        </div>
      )}

      <div className="dec-list">
        {groups.pending.map((d) => (
          <DecisionCard key={d.id} d={d} mounted={mounted} onAct={act} />
        ))}
      </div>

      {groups.postponed.length > 0 && (
        <details className="dec-fold">
          <summary>Aplazadas ({groups.postponed.length})</summary>
          <div className="dec-list">
            {groups.postponed.map((d) => (
              <DecisionCard key={d.id} d={d} mounted={mounted} onAct={act} />
            ))}
          </div>
        </details>
      )}

      {groups.resolved.length > 0 && (
        <details className="dec-fold">
          <summary>Resueltas ({groups.resolved.length})</summary>
          <ul className="dec-history">
            {groups.resolved.map((d) => (
              <ResolvedRow key={d.id} d={d} mounted={mounted} onAct={act} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function DecisionCard({ d, mounted, onAct }: { d: Decision; mounted: boolean; onAct: Act }) {
  const [text, setText] = useState("");
  const [choice, setChoice] = useState("");
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (accion: DecisionAction, extra: { respuesta?: string; opcion?: string; dias?: number } = {}) => {
    setBusy(true);
    try {
      await onAct(d, accion, extra);
    } catch {
      // El error ya se muestra arriba.
    } finally {
      setBusy(false);
      setLater(false);
    }
  };
  const respuesta = text.trim() || undefined;
  const canAnswer = Boolean(respuesta || choice);
  const submit = () => {
    if (busy) return;
    if (d.approval) run("aceptar", { respuesta });
    else if (canAnswer) run("responder", { respuesta, opcion: choice || undefined });
  };
  const placeholder = d.approval ? "Comentario o motivo (opcional)" : d.options.length ? "Añade un comentario (opcional)" : "Escribe tu respuesta…";

  return (
    <article className="dec-card">
      <header className="dec-head">
        <h2>{d.title}</h2>
        <span className="muted small">
          {d.authorName || "Equipo"} · {mounted ? date(d.createdAt) : d.createdAt.slice(0, 10)}
          {d.postponedUntil && mounted && new Date(d.postponedUntil) > new Date() && <> · aplazada hasta {date(d.postponedUntil)}</>}
        </span>
      </header>
      {d.context && (
        <div className="dec-context">
          <Markdown text={d.context} />
        </div>
      )}
      {d.options.length > 0 && (
        <div className="dec-options" role="radiogroup" aria-label="Opciones sugeridas">
          {d.options.map((o) => (
            <button key={o} type="button" role="radio" aria-checked={choice === o} className={`dec-option${choice === o ? " on" : ""}`} onClick={() => setChoice(choice === o ? "" : o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="dec-answer"
        rows={2}
        value={text}
        maxLength={MAX_ANSWER_LENGTH}
        placeholder={placeholder}
        aria-label="Tu respuesta"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <footer className="dec-foot">
        {!later ? (
          <button className="btn small ghost" disabled={busy} onClick={() => setLater(true)}>
            Más tarde
          </button>
        ) : (
          <span className="dec-later">
            {POSTPONE.map((o) => (
              <button key={o.days} className="btn small ghost" disabled={busy} onClick={() => run("aplazar", { dias: o.days })}>
                {o.label}
              </button>
            ))}
            <button className="btn small ghost" onClick={() => setLater(false)} aria-label="Cancelar">
              ✕
            </button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {d.approval ? (
          <>
            <button className="btn small danger" disabled={busy} onClick={() => run("rechazar", { respuesta })}>
              Rechazar
            </button>
            <button className="btn small primary" disabled={busy} onClick={() => run("aceptar", { respuesta })}>
              Aceptar
            </button>
          </>
        ) : (
          <button className="btn small primary" disabled={busy || !canAnswer} onClick={submit} title="También con Ctrl+Intro">
            Responder
          </button>
        )}
      </footer>
    </article>
  );
}

function ResolvedRow({ d, mounted, onAct }: { d: Decision; mounted: boolean; onAct: Act }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className={`dec-row ans-${d.answerKind ?? "none"}`}>
      <div className="dec-row-main">
        <strong>{d.title}</strong>
        <span className="small">{answerLabel(d)}</span>
      </div>
      <span className="muted small">
        {d.authorName || "Equipo"}
        {d.resolvedAt && mounted && <> · {date(d.resolvedAt)}</>}
      </span>
      <button
        className="btn small ghost"
        disabled={busy}
        title="Vuelve a pendientes para responder otra vez"
        onClick={async () => {
          setBusy(true);
          try {
            await onAct(d, "reabrir");
          } catch {
            // El error ya se muestra arriba.
          } finally {
            setBusy(false);
          }
        }}
      >
        Reabrir
      </button>
    </li>
  );
}
