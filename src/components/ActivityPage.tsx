"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, onEvent, useStore } from "@/client/store";
import type { ActivityEntry } from "@/lib/repo/system";
import type { Routine } from "@/lib/repo/routines";
import { describeSchedule } from "@/lib/routines/schedule";
import { dayLabel, groupByDay, timeOf, whenLabel } from "@/lib/ui/text";
import { AvatarPreview } from "./AvatarPreview";
import { useMounted } from "./ui/hooks";
import { Chip, EmptyState, FilterChips, PageHeader, Section, Toolbar } from "./ui/kit";

const KINDS: Record<string, { label: string; icon: string }> = {
  encargo: { label: "Encargos", icon: "📨" },
  rutina: { label: "Rutinas", icon: "🔁" },
  equipo: { label: "Equipo", icon: "👥" },
  exportacion: { label: "Exportaciones", icon: "📤" },
  conexion: { label: "Conexiones", icon: "🔌" },
  archivos: { label: "Archivos", icon: "📁" },
  decisiones: { label: "Decisiones", icon: "⚖️" },
  propuestas: { label: "Propuestas (antiguas)", icon: "💡" },
  autonomo: { label: "Piloto automático", icon: "🤖" },
  error: { label: "Errores", icon: "⚠️" },
  sistema: { label: "Sistema", icon: "⚙️" },
};

/** Registro de actividad: encargos, rutinas, cambios en el equipo y errores, agrupado por día. */
export function ActivityPage() {
  const agents = useStore((s) => s.agents);
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState("");
  const [more, setMore] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
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
          if ((!agentId || a.agentId === agentId) && (!kind || a.kind === kind)) setItems((list) => [a, ...(list ?? [])]);
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
  const days = useMemo(() => groupByDay(items ?? [], (a) => a.createdAt), [items]);

  return (
    <div className="board activity">
      <div className="ui-page">
        <PageHeader title="Actividad" subtitle="Todo lo que hace el equipo, también cuando no miras.">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agente">
            <option value="">Todos los agentes</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </PageHeader>
        <Toolbar>
          <FilterChips
            label="Tipo de actividad"
            value={kind}
            onChange={(k) => setKind(k === kind ? "" : k)}
            options={[{ key: "", label: "Todo" }, ...Object.entries(KINDS).map(([key, k]) => ({ key, label: k.label, icon: k.icon }))]}
          />
        </Toolbar>
        <div className="activity-layout">
          <div className="feed-days">
            {!items && <p className="muted">Cargando…</p>}
            {items && items.length === 0 && (
              <EmptyState icon="🌙" title="Nada por aquí todavía">
                Cuando el equipo haga algo, lo verás aquí ordenado por días.
              </EmptyState>
            )}
            {mounted &&
              days.map((g) => (
                <Section key={g.day} title={dayLabel(g.first)} count={g.items.length}>
                  <ol className="feed">
                    {g.items.map((a) => {
                      const ag = agent(a.agentId);
                      const k = KINDS[a.kind];
                      const open = openId === a.id;
                      return (
                        <li key={a.id} className={`k-${a.kind}${open ? " open" : ""}`}>
                          <span className="feed-avatar">{ag ? <AvatarPreview appearance={ag.appearance} scale={1} /> : <span className="sys-dot" />}</span>
                          <button type="button" className="feed-main" aria-expanded={open} onClick={() => setOpenId(open ? null : a.id)}>
                            <span className="feed-text">{a.text}</span>
                            <span className="feed-meta">
                              <Chip icon={k?.icon} tone={a.kind === "error" ? "bad" : undefined}>
                                {k?.label ?? a.kind}
                              </Chip>
                              {ag && <span className="muted small">{ag.name}</span>}
                            </span>
                          </button>
                          <time className="feed-time muted small" dateTime={a.createdAt}>
                            {timeOf(a.createdAt)}
                          </time>
                        </li>
                      );
                    })}
                  </ol>
                </Section>
              ))}
            {more && items && items.length > 0 && (
              <button
                className="btn ghost small feed-more"
                onClick={() =>
                  query(items.at(-1)!.id).then((r) => {
                    setItems((l) => [...(l ?? []), ...r]);
                    setMore(r.length === 100);
                  })
                }
              >
                Ver más
              </button>
            )}
          </div>
          <aside className="upcoming">
            <Section icon="⏰" title="Próximas rutinas" count={upcoming.length}>
              {upcoming.length === 0 ? (
                <p className="muted small">Sin rutinas programadas. Créalas en la ficha de cada agente o pídeselo a Zen.</p>
              ) : (
                <ul>
                  {upcoming.map((r) => (
                    <li key={r.id} title={describeSchedule(r.schedule)}>
                      <strong>{r.name}</strong>
                      <span className="muted small">
                        {agent(r.agentId)?.name ?? "—"} · {mounted ? whenLabel(r.nextRunAt!) : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </aside>
        </div>
      </div>
    </div>
  );
}
