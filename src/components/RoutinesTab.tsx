"use client";

import { useCallback, useEffect, useState } from "react";
import { api, onEvent } from "@/client/store";
import type { Agent } from "@/lib/types";
import type { Routine } from "@/lib/repo/routines";
import { describeSchedule, ROUTINE_TEMPLATES, type Schedule } from "@/lib/routines/schedule";
import { whenLabel } from "@/lib/ui/text";
import { useMounted } from "./ui/hooks";
import { Card, Chip, EmptyState, SectionHeader } from "./ui/kit";

const DAYS = ["L", "M", "X", "J", "V", "S", "D"];

export function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  const hora = "hora" in value ? value.hora : "08:00";
  const set = (tipo: Schedule["tipo"]) => {
    switch (tipo) {
      case "diaria":
      case "laborables":
        return onChange({ tipo, hora });
      case "semanal":
        return onChange({ tipo, hora, dias: [1] });
      case "mensual":
        return onChange({ tipo, hora, dia: 1 });
      case "intervalo":
        return onChange({ tipo, minutos: 60 });
      case "una_vez": {
        // Dentro de una hora, en hora local (datetime-local no lleva zona).
        const d = new Date(Date.now() + 3600_000);
        return onChange({ tipo, cuando: new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) });
      }
    }
  };
  return (
    <div className="schedule-editor">
      <div className="seg">
        {(
          [
            ["diaria", "Cada día"],
            ["laborables", "Laborables"],
            ["semanal", "Semanal"],
            ["mensual", "Mensual"],
            ["intervalo", "Cada X"],
            ["una_vez", "Una vez"],
          ] as const
        ).map(([k, l]) => (
          <button type="button" key={k} className={value.tipo === k ? "on" : ""} onClick={() => set(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="row">
        {"hora" in value && (
          <label>
            Hora
            <input type="time" value={value.hora} onChange={(e) => onChange({ ...value, hora: e.target.value } as Schedule)} />
          </label>
        )}
        {value.tipo === "semanal" && (
          <div className="days">
            {DAYS.map((d, i) => {
              const n = i + 1;
              const on = value.dias.includes(n);
              return (
                <button
                  type="button"
                  key={d}
                  className={on ? "on" : ""}
                  onClick={() => {
                    const dias = on ? value.dias.filter((x) => x !== n) : [...value.dias, n].sort();
                    if (dias.length) onChange({ ...value, dias });
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
        )}
        {value.tipo === "mensual" && (
          <label>
            Día
            <select value={value.dia} onChange={(e) => onChange({ ...value, dia: Number(e.target.value) })}>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
              <option value={-1}>Último</option>
            </select>
          </label>
        )}
        {value.tipo === "intervalo" && (
          <label>
            Cada (minutos)
            <input type="number" min={5} step={5} value={value.minutos} onChange={(e) => onChange({ ...value, minutos: Math.max(5, Number(e.target.value) || 5) })} />
          </label>
        )}
        {value.tipo === "una_vez" && (
          <label>
            Cuándo
            <input type="datetime-local" value={value.cuando} onChange={(e) => onChange({ ...value, cuando: e.target.value })} />
          </label>
        )}
      </div>
      <span className="hint">Se ejecutará {describeSchedule(value)}.</span>
    </div>
  );
}

interface Draft {
  id?: string;
  name: string;
  prompt: string;
  schedule: Schedule;
}

function RoutineForm({ agent, draft, onClose }: { agent: Agent; draft: Draft; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState("");
  return (
    <form
      className="routine-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          if (d.id) await api(`/api/routines/${d.id}`, { method: "PATCH", json: { name: d.name, prompt: d.prompt, schedule: d.schedule } });
          else await api("/api/routines", { method: "POST", json: { agentId: agent.id, ...d } });
          onClose();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <div className="form-col">
        <label>
          Nombre
          <input autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Resumen de cada mañana" />
        </label>
        <label>
          Qué debe hacer
          <textarea rows={3} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} />
        </label>
        <ScheduleEditor value={d.schedule} onChange={(schedule) => setD({ ...d, schedule })} />
      </div>
      {error && <p className="bad-text small">{error}</p>}
      <div className="row end">
        <button type="button" className="btn ghost small" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary small">{d.id ? "Guardar" : "Crear rutina"}</button>
      </div>
    </form>
  );
}

const fmtDate = (iso: string | null) => (iso ? whenLabel(iso) : "—");

export function RoutinesTab({ agent }: { agent: Agent }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState("");
  const mounted = useMounted();

  const load = useCallback(() => api<Routine[]>(`/api/routines?agentId=${agent.id}`).then(setRoutines), [agent.id]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onEvent((e) => e.type.startsWith("routine.") && load()), [load]);

  const templates = ROUTINE_TEMPLATES.filter((t) => !t.chiefOnly || agent.isChief).filter((t) => !routines?.some((r) => r.name === t.name));

  return (
    <div className="drawer-scroll routines">
      {editing ? (
        <RoutineForm agent={agent} draft={editing} onClose={() => setEditing(null)} />
      ) : (
        <>
          <div className="routines-head">
            <SectionHeader
              icon="🔁"
              title="Rutinas"
              count={routines?.length}
              hint={`Lo que ${agent.name} hace solo`}
              actions={
                <button className="btn primary small" onClick={() => setEditing({ name: "", prompt: "", schedule: { tipo: "diaria", hora: "08:00" } })}>
                  + Rutina
                </button>
              }
            />
          </div>
          {routines?.length === 0 && (
            <EmptyState icon="⏰" title="Sin rutinas todavía">
              Programa algo que {agent.name} haga por su cuenta: un resumen cada mañana, un repaso semanal…
            </EmptyState>
          )}
          <div className="ui-stack routine-cards">
            {routines?.map((r) => {
              const open = openId === r.id;
              return (
                <Card
                  key={r.id}
                  tone={r.enabled ? undefined : "off"}
                  title={r.name}
                  summary={describeSchedule(r.schedule)}
                  open={open}
                  onToggle={() => setOpenId(open ? "" : r.id)}
                  chips={!r.enabled ? <Chip>Pausada</Chip> : open ? <Chip icon="🕒">{describeSchedule(r.schedule)}</Chip> : undefined}
                  meta={mounted && r.enabled && r.nextRunAt ? `próxima: ${fmtDate(r.nextRunAt)}` : undefined}
                  side={
                    <label className="switch" title={r.enabled ? "Pausar" : "Activar"}>
                      <input type="checkbox" checked={r.enabled} onChange={() => api(`/api/routines/${r.id}`, { method: "PATCH", json: { enabled: !r.enabled } })} />
                      <span />
                    </label>
                  }
                  actions={
                    <>
                      <button className="btn small" onClick={() => api(`/api/routines/${r.id}/run`, { method: "POST" }).catch((e) => setError(e.message))}>
                        ▶ Ejecutar ahora
                      </button>
                      <button className="btn small ghost" onClick={() => setEditing({ id: r.id, name: r.name, prompt: r.prompt, schedule: r.schedule })}>
                        ✎ Editar
                      </button>
                      <span style={{ flex: 1 }} />
                      <button className="btn small ghost" onClick={() => confirm(`¿Eliminar «${r.name}»?`) && api(`/api/routines/${r.id}`, { method: "DELETE" })}>
                        Eliminar
                      </button>
                    </>
                  }
                >
                  <p className="ui-detail">{r.prompt}</p>
                  {mounted && <p className="ui-facts">Última ejecución: {fmtDate(r.lastRunAt)}</p>}
                </Card>
              );
            })}
          </div>
          {error && <p className="bad-text small" style={{ padding: "0 16px" }}>{error}</p>}
          {templates.length > 0 && (
            <div className="templates">
              <span className="muted small">Ideas rápidas</span>
              <div className="ui-filters">
                {templates.map((t) => (
                  <button key={t.name} className="ui-filter" title={`${t.prompt} (${describeSchedule(t.schedule)})`} onClick={() => setEditing({ name: t.name, prompt: t.prompt, schedule: t.schedule })}>
                    + {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
