"use client";

import { useCallback, useEffect, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import type { ActivityEntry } from "@/lib/repo/system";
import type { Routine } from "@/lib/repo/routines";
import { describeSchedule } from "@/lib/routines/schedule";
import { AvatarPreview } from "./AvatarPreview";
import { useMounted } from "./panels/common";

const KINDS: Record<string, string> = {
  encargo: "Encargos",
  rutina: "Rutinas",
  equipo: "Equipo",
  exportacion: "Exportaciones",
  conexion: "Conexiones",
  archivos: "Archivos",
  propuestas: "Propuestas",
  error: "Errores",
  sistema: "Sistema",
};

/** Registro de actividad: encargos, rutinas, cambios en el equipo y errores. */
export function ActivityPage() {
  const agents = useStore((s) => s.agents);
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState("");
  const [more, setMore] = useState(true);
  const mounted = useMounted();

  const query = useCallback(
    (before?: number) => {
      const p = new URLSearchParams();
      if (agentId) p.set("agentId", agentId);
      if (kind) p.set("kind", kind);
      if (before) p.set("before", String(before));
      return api<ActivityEntry[]>(`/api/activity?${p}`);
    },
    [agentId, kind],
  );

  useEffect(() => {
    query().then((r) => {
      setItems(r);
      setMore(r.length === 100);
    });
    api<Routine[]>("/api/routines").then(setRoutines);
  }, [query]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "activity.created") {
          const a = e.payload as ActivityEntry;
          if ((!agentId || a.agentId === agentId) && (!kind || a.kind === kind)) setItems((list) => [a, ...list]);
        }
        if (e.type.startsWith("routine.")) api<Routine[]>("/api/routines").then(setRoutines);
      }),
    [agentId, kind],
  );

  const agent = (id: string | null) => agents.find((a) => a.id === id);
  const upcoming = routines
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, 8);

  return (
    <div className="board activity">
      <div className="board-bar">
        <h1>Actividad</h1>
        <span className="muted">Todo lo que hace el equipo, también cuando no miras.</span>
        <span style={{ flex: 1 }} />
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Todos los agentes</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Todo</option>
          {Object.entries(KINDS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="activity-layout">
        <ol className="feed">
          {items.length === 0 && <li className="muted">Nada por aquí todavía.</li>}
          {items.map((a) => {
            const ag = agent(a.agentId);
            return (
              <li key={a.id} className={`k-${a.kind}`}>
                <span className="feed-avatar">{ag ? <AvatarPreview appearance={ag.appearance} scale={1} /> : <span className="sys-dot" />}</span>
                <div>
                  <p>{a.text}</p>
                  <small className="muted">
                    {KINDS[a.kind] ?? a.kind} · {mounted ? new Date(a.createdAt).toLocaleString("es-ES") : ""}
                  </small>
                </div>
              </li>
            );
          })}
          {more && items.length > 0 && (
            <li>
              <button
                className="btn ghost small"
                onClick={() =>
                  query(items.at(-1)!.id).then((r) => {
                    setItems((l) => [...l, ...r]);
                    setMore(r.length === 100);
                  })
                }
              >
                Ver más
              </button>
            </li>
          )}
        </ol>
        <aside className="upcoming">
          <h2>Próximas rutinas</h2>
          {upcoming.length === 0 && <p className="muted small">No hay rutinas programadas. Créalas desde la ficha de cada agente (pestaña Rutinas) o pídeselo a Zen.</p>}
          <ul>
            {upcoming.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong>
                <span className="muted small">
                  {agent(r.agentId)?.name} · {describeSchedule(r.schedule)}
                </span>
                <span className="small">{mounted && new Date(r.nextRunAt!).toLocaleString("es-ES", { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
